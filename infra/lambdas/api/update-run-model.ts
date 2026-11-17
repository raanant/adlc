import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { getRun, updateRun, appendEvent } from "../shared/db";
import { callerIdentity, response } from "./http";

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

/**
 * POST /runs/{runId}/model  { "kiroModel": "claude-haiku-4.5" }
 *
 * Allows changing the implementation model for a run that hasn't started
 * implementing yet (e.g. after seeing the triage model recommendation).
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const runId = event.pathParameters?.runId;
  if (!runId) return response(400, { error: "runId is required" });

  let body: { kiroModel?: unknown };
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return response(400, { error: "invalid JSON" });
  }

  const kiroModel =
    typeof body.kiroModel === "string" ? body.kiroModel.trim() : "";
  if (!kiroModel) return response(400, { error: "kiroModel is required" });
  if (kiroModel !== "auto" && !MODEL_ID_PATTERN.test(kiroModel)) {
    return response(400, { error: "invalid model identifier" });
  }

  const run = await getRun(runId);
  if (!run) return response(404, { error: "run not found" });

  // Only allow changing before implementation starts
  const status = String(run.status ?? "");
  const blocked = ["IMPLEMENTING", "VALIDATING", "COMPLETED", "FAILED", "CANCELLED"];
  if (blocked.includes(status)) {
    return response(409, {
      error: `Cannot change model while run is ${status}`,
    });
  }

  const user = callerIdentity(event);
  const previousModel = String(run.kiroModel ?? "auto");

  await updateRun(runId, { kiroModel });
  await appendEvent(
    runId,
    "MODEL",
    `Implementation model changed from ${previousModel} to ${kiroModel} by ${user.email}`
  );

  return response(200, { ok: true, kiroModel, previousModel });
};
