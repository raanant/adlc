import type { Context } from "aws-lambda";
import { appendEvent, getRun, updateRun } from "../shared/db";
import { BedrockInvocationError, invokeModel, parseJsonResponse } from "../shared/bedrock";
import { type BuildGate, buildSnapshot, compareBuilds, describeBuildGate } from "../shared/build-gate";
import { getBranchDiff, snapshotToPrompt } from "../shared/codecommit";
import {
  type ExecutionMode,
  validateArtifact,
} from "../shared/workflow";

const MODEL_ID = process.env.VALIDATE_MODEL_ID!;
const REPO_NAME = process.env.REPO_NAME!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

interface Check {
  requirement: string;
  pass: boolean;
  note: string;
}

export interface Validation {
  pass: boolean;
  checks: Check[];
  issues: string[];
  fixAttempts: number;
  /**
   * False when another automatic attempt cannot change the outcome (the same build errors as
   * the previous attempt, no new changes, or no changes twice in a row). The state machine then
   * goes to the review gate instead of retrying, whatever attempt budget is left.
   */
  retryable: boolean;
  stopReason?: string;
  buildGate?: BuildGate;
  /** The attempt produced no changes at all (nothing on the branch either). */
  noChanges?: boolean;
  /** The validator model reviewed the diff (it does not when there is no diff). */
  modelReviewed: boolean;
}

const SYSTEM = `You are the INDEPENDENT validation agent in an Agentic SDLC bug-fix pipeline. You did not write this code change. Validate it strictly against the frozen human-approved execution artifact. A change passes only if it fully addresses that artifact and the reported bug, it adds no build error, it introduces no obvious defect or security issue, and it stays in scope.

Build errors listed as pre-existing already fail the commit the run started from. They are out of scope: do not fail the change because of them, and do not ask the coding agent to fix them unless the approved artifact requires it. If the build result says the change adds build errors, the change cannot pass; say which errors to fix.

Respond ONLY with JSON:
{
  "pass": true | false,
  "checks": [{"requirement": "<short name>", "pass": true|false, "note": "<why>"}],
  "issues": ["<actionable finding for the coding agent to fix>", ...]
}
"issues" must be empty when pass is true.`;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function buildCheck(gate: BuildGate): Check {
  return {
    requirement: "Build verification",
    pass: gate.ok,
    note: describeBuildGate(gate),
  };
}

export const handler = async (event: {
  runId: string;
  bugText: string;
  executionMode: ExecutionMode;
  approvedArtifact: string;
  implementResult: {
    fixBranch: string;
    baseCommitId: string;
    fixCommitId?: string;
    buildOk: boolean;
    buildOutput: string;
    buildErrors?: string[];
    noNewChanges?: boolean;
    baselineBuild?: { ok?: unknown; errors?: unknown };
    summary: string;
    attempt: number;
    ok: boolean;
    error?: string;
  };
}, context: Context): Promise<Validation> => {
  const { runId, bugText, executionMode, approvedArtifact, implementResult } = event;
  if (executionMode !== "SIMPLE" && executionMode !== "COMPLEX") {
    throw new Error("executionMode must be SIMPLE or COMPLEX");
  }
  const artifactError = validateArtifact(executionMode, approvedArtifact);
  if (artifactError) throw new Error(artifactError);

  // The previous attempt's validation, to tell whether this attempt changed anything.
  const previous = asRecord((await getRun(runId))?.validation);
  const previousGate = asRecord(previous?.buildGate);

  await updateRun(runId, { status: "VALIDATING" });
  await appendEvent(
    runId,
    "VALIDATE",
    `Independent validation of branch ${implementResult.fixBranch} against the frozen ${executionMode} artifact`
  );

  if (!implementResult.ok) {
    const noChanges = implementResult.error === "no-changes";
    const twiceNoChanges = noChanges && previous?.noChanges === true;
    const validation: Validation = {
      pass: false,
      checks: [
        {
          requirement: "Implementation completed",
          pass: false,
          note: implementResult.error ?? "agent reported failure",
        },
      ],
      issues: [
        noChanges
          ? "The previous attempt made no changes. Implement the approved artifact; the reported bug is not fixed on the branch yet."
          : `The implementation step failed: ${implementResult.error ?? implementResult.summary}. Retry the fix.`,
      ],
      fixAttempts: implementResult.attempt,
      retryable: !twiceNoChanges,
      ...(twiceNoChanges
        ? { stopReason: "Two attempts in a row made no changes, so another automatic attempt would most likely do the same." }
        : {}),
      noChanges,
      modelReviewed: false,
    };
    await updateRun(runId, { validation });
    await appendEvent(runId, "VALIDATE", "Validation FAILED: implementation step did not complete");
    return validation;
  }

  const baselineRecord = asRecord(implementResult.baselineBuild);
  const gate = compareBuilds(
    buildSnapshot(implementResult.buildOk, implementResult.buildErrors),
    baselineRecord ? buildSnapshot(baselineRecord.ok, baselineRecord.errors) : null
  );

  // The validator reviews the diff even when the build gate fails, so a reviewer who has to
  // decide later has a second opinion on the change itself.
  const beforeRef = implementResult.baseCommitId || BASE_BRANCH;
  const afterRef = implementResult.fixCommitId || implementResult.fixBranch;
  const diff = await getBranchDiff(REPO_NAME, beforeRef, afterRef);
  const user = `Original bug report:
---
${bugText}
---

Frozen human-approved execution mode: ${executionMode}
Frozen human-approved artifact:
<approved-artifact>
${approvedArtifact}
</approved-artifact>

Implementation summary from the coding agent (a claim, not evidence): ${implementResult.summary}

Build result, measured by the harness: ${gate.verdict}. ${describeBuildGate(gate)}
${gate.preExistingErrors.length > 0 ? `Pre-existing build errors (out of scope):\n${gate.preExistingErrors.map((e) => `- ${e}`).join("\n")}\n` : ""}${gate.newErrors.length > 0 ? `Build errors added by the change:\n${gate.newErrors.map((e) => `- ${e}`).join("\n")}\n` : ""}Build output (tail):
${implementResult.buildOutput?.slice(-1500) ?? "(none)"}

Changed files: ${diff.changedFiles.join(", ") || "(none detected)"}

Full "after" contents of changed files on ${implementResult.fixBranch}:

${snapshotToPrompt(diff.afterContents)}

Validate the change against the frozen artifact. Respond with the JSON object only.`;

  const res = await invokeModel(MODEL_ID, SYSTEM, user, 1500, {
    getRemainingTimeInMillis: () => context.getRemainingTimeInMillis(),
  });
  let parsed: { pass: boolean; checks: Check[]; issues: string[] };
  try {
    parsed = parseJsonResponse<{ pass: boolean; checks: Check[]; issues: string[] }>(res.text);
    if (typeof parsed.pass !== "boolean" || !Array.isArray(parsed.checks) || !Array.isArray(parsed.issues)) {
      throw new Error("invalid schema");
    }
  } catch {
    throw new BedrockInvocationError(
      "BEDROCK_INVALID_RESPONSE",
      "Model response did not match the validation schema",
      false
    );
  }

  // The harness's build gate is authoritative; the model's own build check is replaced by it.
  const modelChecks = parsed.checks.filter((c) => !/^build/i.test(String(c?.requirement ?? "")));
  const pass = parsed.pass && gate.ok;
  const issues = [
    ...(gate.ok
      ? []
      : [
          `${describeBuildGate(gate)} Fix these build errors.${
            gate.preExistingErrors.length > 0 ? " The pre-existing errors are out of scope." : ""
          } Build output: ${implementResult.buildOutput?.slice(-800) ?? "(none)"}`,
        ]),
    ...(pass ? [] : parsed.issues.map(String)),
  ];

  let retryable = true;
  let stopReason: string | undefined;
  if (!pass && implementResult.noNewChanges) {
    retryable = false;
    stopReason =
      "The last attempt made no new changes (the fix was already on the branch), so another automatic attempt would repeat it.";
  } else if (
    !pass &&
    !gate.ok &&
    implementResult.attempt > 1 &&
    typeof previousGate?.signature === "string" &&
    previousGate.signature === gate.signature
  ) {
    retryable = false;
    stopReason = "The build errors are the same as after the previous attempt, so another automatic attempt is unlikely to help.";
  }

  const validation: Validation = {
    pass,
    checks: [buildCheck(gate), ...modelChecks],
    issues,
    fixAttempts: implementResult.attempt,
    retryable,
    ...(stopReason ? { stopReason } : {}),
    buildGate: gate,
    modelReviewed: true,
  };

  await updateRun(runId, { validation });
  await appendEvent(
    runId,
    "VALIDATE",
    validation.pass
      ? `Validation PASSED: all ${validation.checks.length} checks green${
          gate.verdict === "PRE_EXISTING_ONLY"
            ? ` (the build still fails with ${gate.preExistingErrors.length} pre-existing error(s) from the base commit; the fix adds none)`
            : ""
        }`
      : `Validation FAILED: ${validation.issues.length} finding(s) — ${validation.issues[0]?.slice(0, 150) ?? ""}${
          stopReason ? ` No automatic retry: ${stopReason}` : ""
        }`,
    res.costUsd,
    {
      model: MODEL_ID,
      executionMode,
      checks: validation.checks,
      buildVerdict: gate.verdict,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      totalTokens: res.inputTokens + res.outputTokens,
      costUsd: res.costUsd,
    }
  );
  return validation;
};
