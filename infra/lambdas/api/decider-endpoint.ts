import { randomUUID } from "node:crypto";
import {
  CreateEndpointCommand,
  DeleteEndpointCommand,
  SageMakerClient,
} from "@aws-sdk/client-sagemaker";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  type DeciderEndpointDescription,
  describeDeciderEndpoint,
  isEndpointNotFound,
  sanitizeAwsMessage,
  SERVING_STATES,
  TRANSITIONAL_STATES,
} from "../shared/decider-endpoint";
import { getActiveDeciderVariant, setActiveDeciderVariant } from "../shared/decider-settings";
import {
  type DeciderVariantId,
  type DeciderVariantInfo,
  isDeciderVariantId,
  parseDeciderVariants,
} from "../shared/decider-variants";
import { callerIdentity, response } from "./http";

const sagemaker = new SageMakerClient({ maxAttempts: 2 });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const VARIANTS = parseDeciderVariants(process.env.DECIDER_VARIANTS);
const MODEL_ID = process.env.DECIDER_MODEL_ID ?? "";
const AUDIT_TABLE = process.env.AUDIT_TABLE!;
const SETTINGS_TABLE = process.env.SETTINGS_TABLE!;

type Caller = ReturnType<typeof callerIdentity>;
type AuditAction = "DECIDER_DEPLOY" | "DECIDER_STOP" | "DECIDER_SELECT";

/**
 * Any signed-in user may deploy and stop the endpoints and pick the one the pipeline uses. API
 * Gateway's Cognito JWT authorizer rejects unauthenticated requests before this function runs;
 * this check also refuses a request whose verified token carries no subject, so every audited
 * action names a real user.
 */
function isSignedIn(caller: Caller): boolean {
  return caller.sub !== "unknown" && caller.sub.trim() !== "";
}

function variantView(
  variant: DeciderVariantInfo,
  described: DeciderEndpointDescription,
  active: boolean,
  caller: Caller
) {
  const hourlyUsd = variant.hourlyUsd;
  const running = described.state !== "NOT_DEPLOYED" && described.state !== "Failed";
  const runningHours =
    running && described.creationTime
      ? Math.max(0, (Date.now() - Date.parse(described.creationTime)) / 3_600_000)
      : null;
  const canManage = isSignedIn(caller);
  return {
    variant: variant.id,
    label: variant.label,
    active,
    endpointName: variant.endpointName,
    state: described.state,
    serving: SERVING_STATES.has(described.state),
    transitional: TRANSITIONAL_STATES.has(described.state),
    endpointConfigName: variant.endpointConfigName,
    deployedEndpointConfigName: described.endpointConfigName,
    // The stack replaced the configuration after this endpoint was created from the old one.
    outOfDate:
      described.endpointConfigName !== null &&
      described.endpointConfigName !== variant.endpointConfigName,
    instanceType: variant.instanceType,
    modelId: MODEL_ID,
    hourlyUsd,
    creationTime: described.creationTime,
    lastModifiedTime: described.lastModifiedTime,
    runningHours: runningHours === null ? null : Math.round(runningHours * 100) / 100,
    // Instance-hours since creation; SageMaker bills from the instance start, so this is close to
    // but not exactly the bill.
    estimatedCostUsd:
      runningHours === null || hourlyUsd === null
        ? null
        : Math.round(runningHours * hourlyUsd * 100) / 100,
    failureReason: described.failureReason,
    canManage,
    canDeploy: canManage && described.state === "NOT_DEPLOYED",
    canStop: canManage && described.state !== "NOT_DEPLOYED" && described.state !== "Deleting",
  };
}

/** Status of every variant plus the one the pipeline uses. */
async function overview(caller: Caller) {
  const [active, ...described] = await Promise.all([
    getActiveDeciderVariant(ddb, SETTINGS_TABLE),
    ...VARIANTS.map((v) => describeDeciderEndpoint(sagemaker, v.endpointName)),
  ]);
  return {
    activeVariant: active.variant,
    activeVariantUpdatedAt: active.updatedAt,
    activeVariantUpdatedBy: active.updatedBy,
    canSelect: isSignedIn(caller),
    variants: VARIANTS.map((v, i) => variantView(v, described[i], v.id === active.variant, caller)),
  };
}

async function audit(
  actionId: string,
  action: AuditAction,
  variant: DeciderVariantInfo,
  caller: Caller,
  stateBefore: string
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: AUDIT_TABLE,
      Item: {
        actionId,
        action,
        variant: variant.id,
        endpointName: variant.endpointName,
        endpointConfigName: variant.endpointConfigName,
        callerSub: caller.sub,
        callerEmail: caller.email,
        stateBefore,
        status: "PENDING",
        startedAt: new Date().toISOString(),
      },
      ConditionExpression: "attribute_not_exists(actionId)",
    })
  );
}

async function auditResult(
  actionId: string,
  status: "SUCCEEDED" | "FAILED",
  errorCategory?: string
): Promise<void> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: AUDIT_TABLE,
        Key: { actionId },
        UpdateExpression: "SET #s = :s, completedAt = :now, errorCategory = :e",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":s": status,
          ":now": new Date().toISOString(),
          ":e": errorCategory ?? null,
        },
      })
    );
  } catch (error) {
    // The PENDING record already names the caller and action; do not fail the request on this.
    console.error("decider audit update failed", { actionId, name: (error as Error)?.name });
  }
}

function controlError(
  error: unknown,
  variant: DeciderVariantInfo
): { status: number; code: string; message: string } {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "";
  const message = sanitizeAwsMessage(record.message);
  if (name === "ResourceLimitExceeded") {
    return {
      status: 409,
      code: "QUOTA_EXCEEDED",
      message: `SageMaker quota for ${variant.instanceType} endpoint usage is exhausted: ${message}`,
    };
  }
  if (name === "ValidationException" && /already existing endpoint/i.test(message)) {
    return { status: 409, code: "ALREADY_DEPLOYED", message: "the endpoint already exists" };
  }
  if (isEndpointNotFound(error)) {
    return { status: 409, code: "NOT_DEPLOYED", message: "the endpoint does not exist" };
  }
  if (name === "ValidationException") return { status: 409, code: "INVALID_STATE", message };
  if (name === "AccessDeniedException") {
    return { status: 500, code: "ACCESS_DENIED", message: "the API is not allowed to manage the endpoint" };
  }
  return { status: 502, code: "SAGEMAKER_ERROR", message };
}

async function overviewOrNull(caller: Caller) {
  try {
    return await overview(caller);
  } catch {
    // The action was accepted; the next status poll reports the new state.
    return null;
  }
}

/**
 * GET  /decision-model/endpoint  status of both decider endpoints (CPU and GPU) and the one the
 *                                pipeline uses (any signed-in user)
 * POST /decision-model/endpoint  {"action":"deploy","variant":"cpu"|"gpu","acknowledgeHourlyCost":true}
 *                                {"action":"stop","variant":"cpu"|"gpu"}
 *                                {"action":"select","variant":"cpu"|"gpu"}; any signed-in user
 *
 * Deploy creates the variant's endpoint from its endpoint configuration. Stop deletes it (the
 * configuration, model and weights stay, so it can be deployed again). Select sets which variant
 * new runs use; runs already started keep theirs. Both endpoints may run at once, but a run only
 * ever calls the selected one. Every action is audited with the caller's identity before it is
 * attempted.
 */
export const handler = async (
  event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const caller = callerIdentity(event);
  const method = event.requestContext.http.method;

  if (method === "GET") {
    try {
      return response(200, await overview(caller));
    } catch (error) {
      console.error("decider status failed", { name: (error as Error)?.name });
      return response(502, { error: "endpoint status is unavailable" });
    }
  }
  if (method !== "POST") return response(405, { error: "method not allowed" });

  if (!isSignedIn(caller)) {
    return response(403, { error: "a signed-in user is required" });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(event.body ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
  } catch {
    return response(400, { error: "JSON body must be an object" });
  }
  const action = body.action;
  if (action !== "deploy" && action !== "stop" && action !== "select") {
    return response(400, { error: 'action must be "deploy", "stop" or "select"' });
  }
  if (!isDeciderVariantId(body.variant)) {
    return response(400, { error: 'variant must be "cpu" or "gpu"' });
  }
  const variantId: DeciderVariantId = body.variant;
  const variant = VARIANTS.find((v) => v.id === variantId);
  if (!variant) return response(400, { error: `variant ${variantId} is not deployed in this stack` });
  if (action === "deploy" && body.acknowledgeHourlyCost !== true) {
    return response(400, { error: "acknowledgeHourlyCost must be true: the endpoint is billed per hour" });
  }

  let before: DeciderEndpointDescription;
  let activeBefore: DeciderVariantId;
  try {
    [before, { variant: activeBefore }] = await Promise.all([
      describeDeciderEndpoint(sagemaker, variant.endpointName),
      getActiveDeciderVariant(ddb, SETTINGS_TABLE),
    ]);
  } catch (error) {
    console.error("decider status failed", { name: (error as Error)?.name });
    return response(502, { error: "endpoint status is unavailable" });
  }
  if (action === "deploy" && before.state !== "NOT_DEPLOYED") {
    return response(409, { error: `the ${variant.label} endpoint already exists (${before.state})` });
  }
  if (action === "stop" && (before.state === "NOT_DEPLOYED" || before.state === "Deleting")) {
    return response(409, { error: `nothing to stop (${before.state})` });
  }

  const actionId = randomUUID();
  const auditAction: AuditAction =
    action === "deploy" ? "DECIDER_DEPLOY" : action === "stop" ? "DECIDER_STOP" : "DECIDER_SELECT";
  try {
    await audit(
      actionId,
      auditAction,
      variant,
      caller,
      action === "select" ? `active=${activeBefore}` : before.state
    );
  } catch (error) {
    console.error("decider audit write failed", { name: (error as Error)?.name });
    return response(500, { error: "the action could not be audited, so it was not attempted" });
  }

  try {
    if (action === "deploy") {
      await sagemaker.send(
        new CreateEndpointCommand({
          EndpointName: variant.endpointName,
          EndpointConfigName: variant.endpointConfigName,
        })
      );
    } else if (action === "stop") {
      await sagemaker.send(new DeleteEndpointCommand({ EndpointName: variant.endpointName }));
    } else {
      await setActiveDeciderVariant(ddb, SETTINGS_TABLE, variant.id, caller.email || caller.sub);
    }
  } catch (error) {
    const mapped =
      action === "select"
        ? { status: 502, code: "SETTINGS_WRITE_FAILED", message: "the setting could not be saved" }
        : controlError(error, variant);
    console.warn("decider action failed", { action, variant: variant.id, code: mapped.code, name: (error as Error)?.name });
    await auditResult(actionId, "FAILED", mapped.code);
    return response(mapped.status, { error: mapped.message, code: mapped.code, actionId });
  }
  await auditResult(actionId, "SUCCEEDED");
  console.log("decider action accepted", { action, variant: variant.id, actionId, caller: caller.sub });

  const after = await overviewOrNull(caller);
  return response(action === "select" ? 200 : 202, {
    ok: true,
    action,
    variant: variant.id,
    actionId,
    ...(after ?? {}),
  });
};
