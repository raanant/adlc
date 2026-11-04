import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { appendEvent, getRun } from "../shared/db";
import {
  MAX_GUIDANCE_CHARS,
  MAX_REASON_CHARS,
  MIN_REASON_CHARS,
  type ReviewAction,
  type ReviewDecisionRecord,
  retryAllowance,
} from "../shared/review";
import { type ExecutionMode, validateArtifact } from "../shared/workflow";
import { callerIdentity, response } from "./http";

const sfn = new SFNClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const TABLE = process.env.RUNS_TABLE!;
const COMMIT_ID = /^[0-9a-f]{40}$/;

interface ArtifactVersion {
  version: number;
  mode: ExecutionMode;
  artifact: string;
  createdBy: string;
  createdAt: string;
  source: "execution-gate" | "review-retry";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function failedChecks(run: Record<string, unknown>): string[] {
  const checks = asRecord(run.validation)?.checks;
  return Array.isArray(checks)
    ? checks
        .map(asRecord)
        .filter((c): c is Record<string, unknown> => c !== null && c.pass === false)
        .map((c) => String(c.requirement ?? "check").slice(0, 120))
        .slice(0, 20)
    : [];
}

/**
 * POST /runs/{runId}/review-decision — decide a run waiting at the review gate.
 *
 *   {"action":"accept","reason":"…"}                        accept the fix without a green validation
 *   {"action":"retry","guidance":"…","additionalAttempts":n, "artifact":"…"?}   more attempts with guidance
 *   {"action":"close","reason":"…"?}                        end the run; the fix branch is kept
 *
 * Any signed-in user may decide. The decision is claimed with a conditional write on the run
 * (status AWAITING_REVIEW and the current task token), so two reviewers cannot both decide, and
 * it is recorded on the run before the workflow resumes.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const runId = event.pathParameters?.runId;
  if (!runId) return response(400, { error: "runId is required" });
  const caller = callerIdentity(event);
  if (caller.sub === "unknown" || !caller.sub.trim()) {
    return response(403, { error: "a signed-in user is required" });
  }

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    const record = asRecord(parsed);
    if (!record) return response(400, { error: "JSON body must be an object" });
    body = record;
  } catch {
    return response(400, { error: "invalid JSON body" });
  }
  const action = body.action;
  if (action !== "accept" && action !== "retry" && action !== "close") {
    return response(400, { error: "action must be 'accept', 'retry' or 'close'" });
  }

  const run = await getRun(runId);
  if (!run) return response(404, { error: "run not found" });
  const review = asRecord(run.review);
  const taskToken = typeof run.taskToken === "string" ? run.taskToken : "";
  if (run.status !== "AWAITING_REVIEW" || !taskToken || !review) {
    return response(409, { error: "run is not waiting for a review decision" });
  }
  if (typeof review.expiresAt === "string" && Date.parse(review.expiresAt) <= Date.now()) {
    return response(409, { error: "the review window has closed; the run is being closed" });
  }

  const decisions = Array.isArray(run.reviewDecisions) ? run.reviewDecisions : [];
  const round = decisions.length + 1;
  const attemptsUsed = Number(run.fixAttempts ?? 0) || 0;
  const now = new Date().toISOString();
  const base = {
    round,
    action: action as ReviewAction,
    reviewer: caller.email,
    reviewerSub: caller.sub,
    decidedAt: now,
    failedChecks: failedChecks(run),
    attemptsAtDecision: attemptsUsed,
  };

  const sets: string[] = [
    "reviewDecisions = list_append(if_not_exists(reviewDecisions, :empty), :decision)",
    "updatedAt = :now",
    "#status = :nextStatus",
  ];
  const values: Record<string, unknown> = {
    ":empty": [],
    ":now": now,
    ":waiting": "AWAITING_REVIEW",
    ":token": taskToken,
  };
  let decision: ReviewDecisionRecord;
  let output: Record<string, unknown>;
  let eventMessage: string;

  if (action === "accept") {
    const reason = text(body.reason);
    if (reason.length < MIN_REASON_CHARS || reason.length > MAX_REASON_CHARS) {
      return response(400, {
        error: `reason must be ${MIN_REASON_CHARS}–${MAX_REASON_CHARS} characters: say why the fix is acceptable`,
      });
    }
    const fixCommitId = typeof run.fixCommitId === "string" ? run.fixCommitId : "";
    const fixBranch = typeof run.fixBranch === "string" ? run.fixBranch : "";
    if (!COMMIT_ID.test(fixCommitId) || !fixBranch || fixCommitId === run.baseCommitId) {
      return response(409, { error: "there is no fix commit to accept; retry or close the run instead" });
    }
    decision = { ...base, reason };
    // ACCEPTED_BY_REVIEWER is written by the report step once security review (if any) is done.
    values[":nextStatus"] = "ACCEPTING";
    sets.push("reviewOutcome = :outcome", "acceptedFix = :acceptedFix");
    values[":outcome"] = "accepted";
    values[":acceptedFix"] = { fixBranch, fixCommitId, acceptedBy: caller.email, acceptedAt: now };
    output = { action, acceptedFix: { ok: true, fixBranch, fixCommitId } };
    eventMessage =
      `Fix accepted by ${caller.email} without a green validation (${base.failedChecks.length} failed check(s)): ` +
      `"${reason.slice(0, 300)}"`;
  } else if (action === "retry") {
    const allowance = retryAllowance(round, attemptsUsed);
    if (!allowance.canRetry) {
      return response(409, { error: allowance.reason ?? "retry is not available" });
    }
    const guidance = text(body.guidance);
    if (guidance.length < MIN_REASON_CHARS || guidance.length > MAX_GUIDANCE_CHARS) {
      return response(400, {
        error: `guidance must be ${MIN_REASON_CHARS}–${MAX_GUIDANCE_CHARS} characters: tell Kiro what to do differently`,
      });
    }
    const additional = body.additionalAttempts;
    if (
      typeof additional !== "number" ||
      !Number.isInteger(additional) ||
      additional < 1 ||
      additional > allowance.maxAdditionalAttempts
    ) {
      return response(400, {
        error: `additionalAttempts must be a whole number from 1 to ${allowance.maxAdditionalAttempts}`,
      });
    }
    const mode: ExecutionMode = run.selectedMode === "COMPLEX" ? "COMPLEX" : "SIMPLE";
    const current = typeof run.approvedArtifact === "string"
      ? run.approvedArtifact
      : typeof run.selectedArtifact === "string"
        ? run.selectedArtifact
        : "";
    const proposed = typeof body.artifact === "string" ? body.artifact : current;
    const edited = proposed !== current;
    if (edited) {
      const artifactError = validateArtifact(mode, proposed);
      if (artifactError) return response(400, { error: artifactError });
    }
    const versions: ArtifactVersion[] = Array.isArray(run.artifactVersions)
      ? (run.artifactVersions as ArtifactVersion[])
      : [];
    if (versions.length === 0) {
      const approval = asRecord(run.approval);
      versions.push({
        version: 1,
        mode,
        artifact: current,
        createdBy: String(approval?.reviewer ?? "execution gate"),
        createdAt: String(approval?.decidedAt ?? run.createdAt ?? now),
        source: "execution-gate",
      });
    }
    let artifactVersion = versions[versions.length - 1].version;
    if (edited) {
      artifactVersion += 1;
      versions.push({
        version: artifactVersion,
        mode,
        artifact: proposed,
        createdBy: caller.email,
        createdAt: now,
        source: "review-retry",
      });
      sets.push("selectedArtifact = :artifact");
      values[":artifact"] = proposed;
    }
    const attemptBudget = attemptsUsed + additional;
    decision = {
      ...base,
      guidance,
      additionalAttempts: additional,
      attemptBudget,
      artifactVersion,
      artifactEdited: edited,
    };
    values[":nextStatus"] = "IMPLEMENTING";
    sets.push("artifactVersions = :versions", "attemptBudget = :budget");
    values[":versions"] = versions;
    values[":budget"] = attemptBudget;
    output = { action, attemptBudget, selectedMode: mode, artifact: proposed };
    eventMessage =
      `Retry requested by ${caller.email}: ${additional} more attempt(s)` +
      `${edited ? `, approved artifact edited (version ${artifactVersion})` : ""}. Guidance: "${guidance.slice(0, 300)}"`;
  } else {
    const reason = text(body.reason);
    if (reason.length > MAX_REASON_CHARS) {
      return response(400, { error: `reason exceeds ${MAX_REASON_CHARS} characters` });
    }
    decision = { ...base, ...(reason ? { reason } : {}) };
    values[":nextStatus"] = "CLOSING";
    sets.push("reviewOutcome = :outcome");
    values[":outcome"] = "closed";
    output = { action };
    eventMessage = `Run closed at review by ${caller.email}${reason ? `: "${reason.slice(0, 300)}"` : ""}. The fix branch is kept.`;
  }
  values[":decision"] = [decision];

  // Claim the decision before resuming the workflow.
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { runId },
        UpdateExpression: `SET ${sets.join(", ")} REMOVE taskToken, review`,
        ConditionExpression: "#status = :waiting AND taskToken = :token",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: values,
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      return response(409, { error: "someone else already decided this review" });
    }
    throw error;
  }

  try {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }));
  } catch (error) {
    const name = (error as Error)?.name ?? "";
    console.error("review decision could not resume the workflow", { runId, name });
    if (name === "TaskTimedOut" || name === "TaskDoesNotExist" || name === "InvalidToken") {
      // The review window closed in the meantime; the workflow is closing the run itself.
      await appendEvent(runId, "REVIEW", `Decision by ${caller.email} arrived after the review window closed`);
      return response(409, { error: "the review window closed before the decision arrived" });
    }
    // Undo the claim, restoring every field it changed, so the decision can be submitted again.
    const restoreSets = ["#status = :waiting", "taskToken = :token", "review = :review", "updatedAt = :now"];
    const restoreRemoves = [`reviewDecisions[${decisions.length}]`, "reviewOutcome", "acceptedFix"];
    const restoreValues: Record<string, unknown> = {
      ":waiting": "AWAITING_REVIEW",
      ":token": taskToken,
      ":review": review,
      ":now": new Date().toISOString(),
    };
    if (Array.isArray(run.artifactVersions)) {
      restoreSets.push("artifactVersions = :prevVersions");
      restoreValues[":prevVersions"] = run.artifactVersions;
    } else {
      restoreRemoves.push("artifactVersions");
    }
    if (typeof run.selectedArtifact === "string") {
      restoreSets.push("selectedArtifact = :prevArtifact");
      restoreValues[":prevArtifact"] = run.selectedArtifact;
    }
    if (typeof run.attemptBudget === "number") {
      restoreSets.push("attemptBudget = :prevBudget");
      restoreValues[":prevBudget"] = run.attemptBudget;
    }
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { runId },
        UpdateExpression: `SET ${restoreSets.join(", ")} REMOVE ${restoreRemoves.join(", ")}`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: restoreValues,
      })
    );
    return response(502, { error: "the workflow could not be resumed; try again" });
  }

  await appendEvent(runId, "REVIEW", eventMessage);
  return response(200, { ok: true, action, round });
};
