import type { Context } from "aws-lambda";
import {
  InvokeEndpointCommand,
  SageMakerRuntimeClient,
} from "@aws-sdk/client-sagemaker-runtime";
import { appendEvent, updateRun } from "../shared/db";
import {
  buildDeciderRequest,
  buildDeciderState,
  classifyDeciderError,
  type ClassifiedDeciderError,
  type Complexity,
  type DeciderAnswer,
  DeciderResponseError,
  type DeciderPromptRecord,
  deciderPromptRecord,
  type DeciderStateStats,
  parseDeciderResponse,
} from "../shared/decider";
import {
  DEFAULT_DECIDER_VARIANT,
  type DeciderVariantInfo,
  isDeciderVariantId,
  parseDeciderVariants,
} from "../shared/decider-variants";

/** The endpoints this step may call; a run names a variant id, never an endpoint name. */
const VARIANTS = parseDeciderVariants(process.env.DECIDER_VARIANTS);
/** SageMaker real-time invocations time out after 60 seconds on the service side. */
const INVOKE_TIMEOUT_MS = 65_000;
/** Time kept back to record the outcome before the function times out. */
const RESERVE_MS = 8_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_BUG_TEXT_CHARS = 20_000;

const client = new SageMakerRuntimeClient({ maxAttempts: 2 });

interface DecisionModelInput {
  runId: string;
  bugText?: unknown;
  /** "cpu" or "gpu": the endpoint picked in Settings when the run started. */
  variant?: unknown;
  triage?: { complexity?: unknown };
}

/** The Step Functions result. Routing never reads it; it exists for the execution history. */
export interface DecisionModelSummary {
  status: "COMPLETED" | "FAILED" | "UNAVAILABLE";
  verdict?: Complexity;
  agreesWithLlm?: boolean | null;
  errorCode?: string;
}

class InputError extends Error {}

function llmVerdictOf(triage: DecisionModelInput["triage"]): Complexity | null {
  const value = triage?.complexity;
  return value === "SIMPLE" || value === "COMPLEX" ? value : null;
}

function completedMessage(answer: DeciderAnswer, llmVerdict: Complexity | null, label: string): string {
  const comparison =
    llmVerdict === null
      ? "No LLM triage verdict to compare."
      : answer.verdict === llmVerdict
        ? `Agrees with the LLM triage (${llmVerdict}).`
        : `Disagrees with the LLM triage (${llmVerdict}).`;
  const checks = answer.checks
    .map((c) => `${c.passes ? "pass" : "fail"} ${c.label} ${Math.round((c.passes ? c.pSimple : 1 - c.pSimple) * 100)}%`)
    .join(", ");
  return (
    `Decision model (${answer.modelId}, ${label} endpoint): ${answer.verdict}, ${Math.round(answer.probability * 100)}% likely ` +
    `(${answer.certainty} certainty). Checks: ${checks}. ${comparison} Informative only; routing is unchanged.`
  );
}

async function invokeDecider(
  endpointName: string,
  body: string,
  context: Context
): Promise<{ answer: DeciderAnswer; roundTripMs: number }> {
  const budget = Math.min(INVOKE_TIMEOUT_MS, context.getRemainingTimeInMillis() - RESERVE_MS);
  if (budget < 5_000) {
    throw Object.assign(new Error("not enough time left"), { name: "TimeoutError" });
  }
  const started = Date.now();
  const res = await client.send(
    new InvokeEndpointCommand({
      EndpointName: endpointName,
      ContentType: "application/json",
      Accept: "application/json",
      Body: Buffer.from(body, "utf8"),
    }),
    { abortSignal: AbortSignal.timeout(budget) }
  );
  const roundTripMs = Date.now() - started;
  const bytes = res.Body ?? new Uint8Array();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new DeciderResponseError("decider response is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new DeciderResponseError("decider response is not JSON");
  }
  return { answer: parseDeciderResponse(parsed), roundTripMs };
}

/**
 * Ask the Strands Decider endpoint for an independent SIMPLE/COMPLEX classification and record it
 * next to the LLM triage. Every outcome is recorded on the run and the function returns normally,
 * so the pipeline always continues: this step is informative and never changes routing.
 */
export const handler = async (
  event: DecisionModelInput,
  context: Context
): Promise<DecisionModelSummary> => {
  const { runId } = event;
  const llmVerdict = llmVerdictOf(event.triage);
  // Runs started before the GPU variant existed carry no variant: they used the CPU endpoint.
  const variantId = event.variant === undefined || event.variant === null ? DEFAULT_DECIDER_VARIANT : event.variant;
  const variant: DeciderVariantInfo | undefined = isDeciderVariantId(variantId)
    ? VARIANTS.find((v) => v.id === variantId)
    : undefined;
  const endpointName = variant?.endpointName ?? "";
  const base = {
    provider: "strands-decider",
    variant: variant?.id ?? null,
    variantLabel: variant?.label ?? null,
    endpointName,
    instanceType: variant?.instanceType ?? null,
    advisoryOnly: true,
    llmVerdict,
    startedAt: new Date().toISOString(),
  };
  await updateRun(runId, { decisionModel: { ...base, status: "RUNNING" } });
  await appendEvent(
    runId,
    "DECISION_MODEL",
    `Decision model second opinion requested from the ${variant?.label ?? "unknown"} endpoint ` +
      "(informative only; routing stays with the LLM triage)"
  );

  let stats: DeciderStateStats | undefined;
  let prompt: DeciderPromptRecord | undefined;
  try {
    if (!endpointName) {
      throw new InputError(`the run names an unknown decision model variant (${String(variantId).slice(0, 20)})`);
    }
    const bugText = typeof event.bugText === "string" ? event.bugText : "";
    if (!bugText.trim() || bugText.length > MAX_BUG_TEXT_CHARS) {
      throw new InputError("bug text is empty or too long");
    }

    // The checks follow the default triage guidance; the run's own guidance text is not sent.
    const built = buildDeciderState(bugText);
    stats = built.stats;
    const requestBody = buildDeciderRequest(built.state);
    prompt = deciderPromptRecord(requestBody);
    const { answer, roundTripMs } = await invokeDecider(endpointName, JSON.stringify(requestBody), context);
    const agreesWithLlm = llmVerdict === null ? null : answer.verdict === llmVerdict;

    await updateRun(runId, {
      decisionModel: {
        ...base,
        status: "COMPLETED",
        ...answer,
        agreesWithLlm,
        roundTripMs,
        input: stats,
        prompt,
        completedAt: new Date().toISOString(),
      },
    });
    await appendEvent(runId, "DECISION_MODEL", completedMessage(answer, llmVerdict, variant!.label), undefined, {
      model: answer.modelId,
      variant: variant!.id,
      verdict: answer.verdict,
      probability: answer.probability,
      certainty: answer.certainty,
      decidingCheck: answer.decidingCheck,
      agreesWithLlm,
      inputTokens: answer.inputTokens,
      roundTripMs,
    });
    console.log("decision model answered", {
      verdict: answer.verdict,
      probability: answer.probability,
      decidingCheck: answer.decidingCheck,
      agreesWithLlm,
      roundTripMs,
      stateChars: stats.stateChars,
    });
    return { status: "COMPLETED", verdict: answer.verdict, agreesWithLlm };
  } catch (error) {
    const classified: ClassifiedDeciderError =
      error instanceof InputError
        ? { code: "DECIDER_INPUT_FAILED", status: "FAILED", message: error.message }
        : classifyDeciderError(error);
    console.warn("decision model did not answer", {
      code: classified.code,
      name: (error as Error)?.name,
    });
    await updateRun(runId, {
      decisionModel: {
        ...base,
        status: classified.status,
        error: { code: classified.code, message: classified.message },
        ...(stats ? { input: stats } : {}),
        ...(prompt ? { prompt } : {}),
        completedAt: new Date().toISOString(),
      },
    });
    await appendEvent(
      runId,
      "DECISION_MODEL",
      `Decision model ${classified.status === "UNAVAILABLE" ? "unavailable" : "failed"} ` +
        `(${classified.code}): ${classified.message}. The run continues with the LLM triage.`
    );
    return { status: classified.status, errorCode: classified.code };
  }
};
