import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_TRIAGE_INSTRUCTION,
  isAllowedAnalysisModel,
  MAX_TRIAGE_INSTRUCTION_CHARS,
} from "../shared/workflow";
import { MCP_CONFIG_KEY, validateMcpConfig } from "../shared/mcp";
import { getActiveDeciderVariant } from "../shared/decider-settings";
import { DEFAULT_DECIDER_VARIANT, type DeciderVariantId } from "../shared/decider-variants";
import { callerIdentity, response } from "./http";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sfn = new SFNClient({});
const TABLE = process.env.RUNS_TABLE!;
const CONTEXT_TABLE = process.env.CONTEXT_TABLE ?? "";
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const SECURITY_AGENT_ENABLED = process.env.SECURITY_AGENT_ENABLED === "true";
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? "";

/**
 * The decision-model variant (CPU or GPU endpoint) picked in Settings, fixed for this run at
 * submission so a later change in Settings cannot switch an in-flight run.
 */
async function snapshotDeciderVariant(): Promise<{ variant: DeciderVariantId; readFailed: boolean }> {
  if (!SETTINGS_TABLE) return { variant: DEFAULT_DECIDER_VARIANT, readFailed: false };
  try {
    return { variant: (await getActiveDeciderVariant(ddb, SETTINGS_TABLE)).variant, readFailed: false };
  } catch (error) {
    console.warn("decision model setting read failed; using the default variant", {
      name: (error as Error)?.name,
    });
    return { variant: DEFAULT_DECIDER_VARIANT, readFailed: true };
  }
}

/**
 * Snapshot the caller's saved MCP configuration at submission time so the run
 * is auditable and later config edits cannot change an in-flight run.
 */
async function snapshotMcpConfig(owner: string): Promise<{
  mcpConfig: string;
  mcpEnabledServers: string[];
}> {
  if (!CONTEXT_TABLE) return { mcpConfig: "", mcpEnabledServers: [] };
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName: CONTEXT_TABLE,
        Key: { ownerSub: owner, itemKey: MCP_CONFIG_KEY },
      })
    );
    const configJson =
      typeof result.Item?.configJson === "string" ? result.Item.configJson : "";
    const validation = validateMcpConfig(configJson);
    if (validation.error || validation.enabledCount === 0) {
      return { mcpConfig: "", mcpEnabledServers: [] };
    }
    return { mcpConfig: configJson, mcpEnabledServers: validation.serverNames };
  } catch (error) {
    console.warn("MCP config snapshot failed; run continues without MCP", error);
    return { mcpConfig: "", mcpEnabledServers: [] };
  }
}
const MAX_INPUT_CHARS = 20_000;
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

interface StartRunBody {
  bugText?: unknown;
  kiroModel?: unknown;
  analysisModel?: unknown;
  triageInstruction?: unknown;
  includeContext?: unknown;
  autoExecuteSimple?: unknown;
  securityRemediation?: unknown;
  securityMode?: unknown;
  decisionModelEnabled?: unknown;
}

export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  let body: StartRunBody;
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response(400, { error: "JSON body must be an object" });
    }
    body = parsed as StartRunBody;
  } catch {
    return response(400, { error: "invalid JSON body" });
  }

  const bugText = typeof body.bugText === "string" ? body.bugText.trim() : "";
  const kiroModel =
    typeof body.kiroModel === "string" && body.kiroModel.trim()
      ? body.kiroModel.trim()
      : "auto";
  const analysisModel =
    typeof body.analysisModel === "string" && body.analysisModel.trim()
      ? body.analysisModel.trim()
      : DEFAULT_ANALYSIS_MODEL;
  const triageInstruction =
    typeof body.triageInstruction === "string"
      ? body.triageInstruction.trim()
      : DEFAULT_TRIAGE_INSTRUCTION;
  const includeContext = body.includeContext === undefined ? false : body.includeContext;
  const autoExecuteSimple =
    body.autoExecuteSimple === undefined ? false : body.autoExecuteSimple;
  const securityRemediation =
    body.securityRemediation === undefined ? false : body.securityRemediation;
  // Optional informative second opinion from the Strands Decider endpoint; never changes routing.
  const decisionModelEnabled =
    body.decisionModelEnabled === undefined ? false : body.decisionModelEnabled;
  const requestedSecurityMode =
    typeof body.securityMode === "string" && ["skip", "scan", "remediate"].includes(body.securityMode)
      ? body.securityMode
      : (body.securityRemediation === true ? "remediate" : "scan");
  // Without a provisioned agent space (cdk deploy -c securityAgent=false) there is nothing to
  // run the review in, so the run skips it instead of failing after validation.
  const securityMode = SECURITY_AGENT_ENABLED ? requestedSecurityMode : "skip";

  if (typeof includeContext !== "boolean") {
    return response(400, { error: "includeContext must be a boolean" });
  }
  if (typeof autoExecuteSimple !== "boolean") {
    return response(400, { error: "autoExecuteSimple must be a boolean" });
  }
  if (typeof securityRemediation !== "boolean") {
    return response(400, { error: "securityRemediation must be a boolean" });
  }
  if (typeof decisionModelEnabled !== "boolean") {
    return response(400, { error: "decisionModelEnabled must be a boolean" });
  }

  if (!bugText) return response(400, { error: "bugText is required" });
  if (bugText.length > MAX_INPUT_CHARS) {
    return response(400, { error: `bugText exceeds ${MAX_INPUT_CHARS} characters` });
  }
  if (kiroModel !== "auto" && !MODEL_ID_PATTERN.test(kiroModel)) {
    return response(400, { error: "invalid Kiro model identifier" });
  }
  if (!isAllowedAnalysisModel(analysisModel)) {
    return response(400, { error: "analysisModel is not in the supported allowlist" });
  }
  if (!triageInstruction) {
    return response(400, { error: "triageInstruction must not be empty" });
  }
  if (triageInstruction.length > MAX_TRIAGE_INSTRUCTION_CHARS) {
    return response(400, {
      error: `triageInstruction exceeds ${MAX_TRIAGE_INSTRUCTION_CHARS} characters`,
    });
  }

  const user = callerIdentity(event);
  const runId = randomUUID();
  const now = new Date().toISOString();
  const workflowVersion = 2;
  const { mcpConfig, mcpEnabledServers } = await snapshotMcpConfig(user.sub);
  const decider = decisionModelEnabled
    ? await snapshotDeciderVariant()
    : { variant: undefined, readFailed: false };

  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        runId,
        status: "PENDING",
        bugText,
        kiroModel,
        analysisModel,
        triageInstruction,
        includeContext,
        autoExecuteSimple,
        securityRemediation,
        securityMode,
        decisionModelEnabled,
        ...(decider.variant ? { decisionModelVariant: decider.variant } : {}),
        mcpConfig,
        mcpEnabledServers,
        workflowVersion,
        createdAt: now,
        updatedAt: now,
        costUsd: 0,
        startedBy: user.email,
        startedBySub: user.sub,
        events: [
          {
            ts: now,
            phase: "SUBMITTED",
            message: `Run submitted by ${user.email}; analysis model: ${analysisModel}; implementation model: ${kiroModel}`,
          },
        ],
        logs: [
          {
            ts: now,
            level: "INFO",
            stage: "workflow",
            message: `Run accepted; analysis model: ${analysisModel}; implementation model: ${kiroModel}`,
          },
          ...(securityMode !== requestedSecurityMode
            ? [
                {
                  ts: now,
                  level: "WARN",
                  stage: "workflow",
                  message: `Security review "${requestedSecurityMode}" was requested but AWS Security Agent is not provisioned in this deployment; the run skips it`,
                },
              ]
            : []),
          ...(mcpEnabledServers.length > 0
            ? [
                {
                  ts: now,
                  level: "INFO",
                  stage: "mcp",
                  message: `MCP configuration snapshotted for this run; enabled server(s): ${mcpEnabledServers.join(", ")}`,
                },
              ]
            : []),
          ...(decider.variant
            ? [
                {
                  ts: now,
                  level: decider.readFailed ? "WARN" : "INFO",
                  stage: "decision-model",
                  message: decider.readFailed
                    ? `The decision model setting could not be read; this run uses the default ${decider.variant.toUpperCase()} endpoint`
                    : `Decision model second opinion uses the ${decider.variant.toUpperCase()} endpoint (selected in Settings)`,
                },
              ]
            : []),
        ],
        logCount:
          1 +
          (mcpEnabledServers.length > 0 ? 1 : 0) +
          (securityMode !== requestedSecurityMode ? 1 : 0) +
          (decider.variant ? 1 : 0),
      },
    })
  );

  await sfn.send(
    new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: runId,
      input: JSON.stringify({
        runId,
        bugText,
        kiroModel,
        analysisModel,
        triageInstruction,
        includeContext,
        autoExecuteSimple,
        securityRemediation,
        securityMode,
        decisionModelEnabled,
        // Always present so the state machine's JSONPath reads it; the step ignores it when the
        // second opinion is off.
        decisionModelVariant: decider.variant ?? DEFAULT_DECIDER_VARIANT,
        ownerSub: user.sub,
        workflowVersion,
      }),
    })
  );

  return response(201, { runId });
};
