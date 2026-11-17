import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { appendEvent, getRun, removeField, updateRun } from "../shared/db";
import { callerIdentity, response } from "./http";

const sfn = new SFNClient({});

type SecurityGateAction = "accept" | "remediate";

interface SecurityGateBody {
  action?: unknown;
  feedback?: unknown;
}

/** POST /runs/{runId}/security-decision — accept risks or remediate. */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const runId = event.pathParameters?.runId;
  if (!runId) return response(400, { error: "runId is required" });

  let body: SecurityGateBody;
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(400, { error: "JSON body must be an object" });
    }
    body = parsed as SecurityGateBody;
  } catch {
    return response(400, { error: "invalid JSON body" });
  }

  if (body.action !== "accept" && body.action !== "remediate") {
    return response(400, { error: "action must be 'accept' or 'remediate'" });
  }

  const action: SecurityGateAction = body.action;
  const feedback = typeof body.feedback === "string" ? body.feedback.slice(0, 4000) : "";

  const run = await getRun(runId);
  if (!run) return response(404, { error: "run not found" });
  if (run.status !== "AWAITING_SECURITY_GATE" || !run.taskToken) {
    return response(409, { error: "run is not awaiting a security gate decision" });
  }

  const reviewer = callerIdentity(event);

  // Build remediation bug text from security findings if remediating
  let remediationBugText = "";
  if (action === "remediate") {
    const securityReview = run.securityReview as {
      findings?: Array<{ name?: string; riskLevel?: string; remediation?: string; description?: string }>;
    } | undefined;
    const findings = securityReview?.findings ?? [];
    const actionable = findings.filter((f) => f.riskLevel === "HIGH" || f.riskLevel === "CRITICAL");
    const lines = [
      "## Security Remediation Required",
      "",
      `The following security findings from automated scanning need to be fixed:`,
      "",
    ];
    for (const f of (actionable.length > 0 ? actionable : findings).slice(0, 15)) {
      lines.push(`### [${f.riskLevel}] ${f.name}`);
      if (f.description) lines.push(`Description: ${f.description}`);
      if (f.remediation) lines.push(`Remediation: ${f.remediation}`);
      lines.push("");
    }
    if (feedback) {
      lines.push(`### Additional guidance from reviewer`, "", feedback, "");
    }
    remediationBugText = lines.join("\n");
  }

  const securityDecision = {
    action,
    feedback,
    remediationBugText,
    reviewer: reviewer.email,
    reviewerSub: reviewer.sub,
    decidedAt: new Date().toISOString(),
  };

  await sfn.send(
    new SendTaskSuccessCommand({
      taskToken: String(run.taskToken),
      output: JSON.stringify(securityDecision),
    })
  );

  await removeField(runId, "taskToken");
  await updateRun(runId, { securityDecision });
  await appendEvent(
    runId,
    "SECURITY_GATE",
    action === "accept"
      ? `✅ Security findings accepted by ${reviewer.email}${feedback ? ` — "${feedback.slice(0, 200)}"` : ""}`
      : `🔄 Remediation requested by ${reviewer.email} — findings will be fed back to Kiro for fixing`
  );

  return response(200, { ok: true, action });
};
