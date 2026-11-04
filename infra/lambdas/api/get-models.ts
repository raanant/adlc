import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { SageMakerClient } from "@aws-sdk/client-sagemaker";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  ANALYSIS_MODELS,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_TRIAGE_INSTRUCTION,
} from "../shared/workflow";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describeDeciderEndpoint, SERVING_STATES } from "../shared/decider-endpoint";
import { getActiveDeciderVariant } from "../shared/decider-settings";
import { DEFAULT_DECIDER_VARIANT, parseDeciderVariants } from "../shared/decider-variants";
import { response } from "./http";

const client = new BedrockAgentCoreClient({ maxAttempts: 1 });
const sagemaker = new SageMakerClient({ maxAttempts: 2 });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
/**
 * One stable AgentCore session for model discovery. A new session id starts a new microVM, which
 * takes 25-30 s to boot, longer than API Gateway allows. Reusing one id keeps a warm container
 * between calls (until the runtime's idle timeout). The session only lists the models of the
 * deployment's Kiro key: no user data, so sharing it across users is safe.
 */
const DISCOVERY_SESSION_ID = "adlc-poc-kiro-model-discovery-session-0001";
/** Leaves room for the rest of the response inside the 29 s function and 30 s API limits. */
const DISCOVERY_BUDGET_MS = 20_000;
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;
const DECIDER_VARIANTS = parseDeciderVariants(process.env.DECIDER_VARIANTS);
const DECIDER_MODEL_ID = process.env.DECIDER_MODEL_ID ?? "";
const SETTINGS_TABLE = process.env.SETTINGS_TABLE ?? "";

interface ModelOption {
  id: string;
  name: string;
}

interface ModelsResult {
  kiroConfigured: boolean;
  models: ModelOption[];
  /** True when discovery ran out of time while the agent container was starting; retry soon. */
  kiroDiscoveryPending?: boolean;
  error?: string;
}

/**
 * Availability of the decider endpoint the pipeline uses (picked in Settings), for the run form.
 * Only that endpoint matters: a run never calls the other one.
 */
interface DecisionModelStatus {
  available: boolean;
  /** SageMaker EndpointStatus, or NOT_DEPLOYED / NOT_CONFIGURED / UNKNOWN. */
  status: string;
  variant: string;
  label: string;
  endpointName: string;
  instanceType: string;
  modelId: string;
}

async function kiroModels(): Promise<ModelsResult> {
  const abortSignal = AbortSignal.timeout(DISCOVERY_BUDGET_MS);
  try {
    const res = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        qualifier: "DEFAULT",
        runtimeSessionId: DISCOVERY_SESSION_ID,
        contentType: "application/json",
        accept: "application/json",
        payload: Buffer.from(JSON.stringify({ action: "listModels" })),
      }),
      { abortSignal }
    );
    const bodyText = res.response
      ? Buffer.from(await res.response.transformToByteArray()).toString("utf-8")
      : "{}";
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && "result" in parsed
      ? (parsed.result as ModelsResult)
      : (parsed as unknown as ModelsResult);
  } catch (error) {
    if (abortSignal.aborted) {
      // The session keeps booting server-side, so the next call usually finds it warm.
      console.warn("model discovery exceeded its budget; the agent container is starting");
      return {
        kiroConfigured: false,
        models: [],
        kiroDiscoveryPending: true,
        error: "The coding agent is starting; Kiro models will load in a few seconds",
      };
    }
    console.error("model discovery failed", error);
    return {
      kiroConfigured: false,
      models: [],
      error: "Kiro model discovery is temporarily unavailable",
    };
  }
}

async function decisionModelStatus(): Promise<DecisionModelStatus> {
  let variantId = DEFAULT_DECIDER_VARIANT;
  try {
    if (SETTINGS_TABLE) variantId = (await getActiveDeciderVariant(ddb, SETTINGS_TABLE)).variant;
  } catch (error) {
    console.warn("decision model setting read failed", { name: (error as Error)?.name });
    return {
      available: false,
      status: "UNKNOWN",
      variant: variantId,
      label: "",
      endpointName: "",
      instanceType: "",
      modelId: DECIDER_MODEL_ID,
    };
  }
  const variant = DECIDER_VARIANTS.find((v) => v.id === variantId);
  const base = {
    variant: variantId,
    label: variant?.label ?? "",
    endpointName: variant?.endpointName ?? "",
    instanceType: variant?.instanceType ?? "",
    modelId: DECIDER_MODEL_ID,
  };
  if (!variant) return { ...base, available: false, status: "NOT_CONFIGURED" };
  try {
    const described = await describeDeciderEndpoint(sagemaker, variant.endpointName);
    return { ...base, available: SERVING_STATES.has(described.state), status: described.state };
  } catch (error) {
    console.warn("decision model status check failed", { name: (error as Error)?.name });
    return { ...base, available: false, status: "UNKNOWN" };
  }
}

/** List the models available to the Kiro API key used by AgentCore, and the decider status. */
export const handler = async (
  _event: APIGatewayProxyEventV2WithJWTAuthorizer
): Promise<APIGatewayProxyResultV2> => {
  const [kiro, decisionModel] = await Promise.all([kiroModels(), decisionModelStatus()]);
  return response(200, {
    ...kiro,
    analysisModels: ANALYSIS_MODELS,
    defaultAnalysisModel: DEFAULT_ANALYSIS_MODEL,
    defaultTriageInstruction: DEFAULT_TRIAGE_INSTRUCTION,
    decisionModel,
    // False when the stack was deployed with -c securityAgent=false.
    securityAgent: { enabled: process.env.SECURITY_AGENT_ENABLED === "true" },
  });
};
