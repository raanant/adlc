/**
 * Strands Decider (a "System One" decision model) as an informative second opinion on the
 * SIMPLE/COMPLEX triage. A decision model never generates text: for each question it scores a
 * fixed set of options and returns a calibrated probability. Its answer is recorded and shown;
 * it never changes routing, which stays with the LLM triage verdict.
 *
 * Request design. One broad "is this simple?" question was a weak fit for a small model: it saw
 * an alarming bug report as complex. The model is better at narrow yes/no questions, so the
 * request asks one question per condition of the default triage guidance (SIMPLE: no new
 * dependency, no data-model change, no contract change, no new component, a small edit). The
 * verdict follows from the checks with a fixed rule (deciderVerdict). The state is the bug report
 * alone: the LLM's verdict is never sent, so the two answers stay independent. Measured results
 * are in decider/README.md; decider/eval/ has the cases and the script.
 *
 * Wire format: strands-decider's System One API (POST /invocations on the SageMaker endpoint).
 */

export type Complexity = "SIMPLE" | "COMPLEX";

/**
 * The checkpoint's 4,096-token window holds the state and every question. The questions are
 * about 600 tokens together, so the bug report is capped at about 2,500 tokens.
 */
export const BUG_REPORT_MAX_CHARS = 8_000;

export interface DeciderCheck {
  id: string;
  /** Short name shown in the UI. */
  label: string;
  /** The yes/no question the model answers. */
  question: string;
  /** What "true" means, as the model reads it. */
  whenTrue: string;
  /** What "false" means, as the model reads it. */
  whenFalse: string;
  /** The answer that keeps the fix SIMPLE. */
  simpleWhen: boolean;
  /** UI wording for the SIMPLE-side and COMPLEX-side outcome. */
  simpleText: string;
  complexText: string;
}

const SUBJECT = "the change the bug report asks for";

/** One check per condition of the default triage guidance (workflow.ts). */
export const DECIDER_CHECKS: readonly DeciderCheck[] = [
  {
    id: "new_dependency",
    label: "New dependency",
    question: `Does ${SUBJECT} require adding a library, SDK or external service that the project does not already use?`,
    whenTrue: "a new library, SDK or external service must be added",
    whenFalse: "the project's existing libraries and services are enough",
    simpleWhen: false,
    simpleText: "No new library or service needed",
    complexText: "Needs a new library or external service",
  },
  {
    id: "data_model_change",
    label: "Data model",
    question: `Does ${SUBJECT} require storing a new kind of data or changing how existing data is stored, such as a new field, column, table or migration?`,
    whenTrue: "what is stored, or how it is stored, must change",
    whenFalse: "the stored data stays exactly as it is",
    simpleWhen: false,
    simpleText: "Stored data stays as it is",
    complexText: "Changes what or how data is stored",
  },
  {
    id: "contract_change",
    label: "API contract",
    question: `Would existing API clients or other services have to change their own code because of ${SUBJECT}? Making an endpoint behave as documented does not count.`,
    whenTrue: "existing clients or services must be updated to keep working",
    whenFalse: "existing clients keep working unchanged, or the change only makes the API behave as intended",
    simpleWhen: false,
    simpleText: "Existing clients keep working unchanged",
    complexText: "Existing clients or services must change",
  },
  {
    id: "new_component",
    label: "New component",
    question: `Does ${SUBJECT} require building something the project does not have yet, such as a cache, queue, background job, scheduler, email or notification sending, or a login system?`,
    whenTrue: "a new component or capability must be built",
    whenFalse: "it is a change inside code that already exists",
    simpleWhen: false,
    simpleText: "Stays inside existing code",
    complexText: "Needs a new component or capability",
  },
  {
    id: "small_scope",
    label: "Size",
    question: `Is ${SUBJECT} a small, local edit to existing code, in fewer than 5 files?`,
    whenTrue: "a small edit to existing code in fewer than 5 files",
    whenFalse: "edits across 5 or more files or substantial new code",
    simpleWhen: true,
    simpleText: "A small edit in fewer than 5 files",
    complexText: "Too large for a small, local edit",
  },
];

/** Certainty bands of the upstream routing convention, expressed on the verdict's probability. */
export type Certainty = "HIGH" | "MEDIUM" | "LOW";
export function certaintyOf(probability: number): Certainty {
  // Upstream bands are on confidence c = 2p - 1: >= 0.9 act, >= 0.5 confirm, below that ask.
  if (probability >= 0.95) return "HIGH";
  if (probability >= 0.75) return "MEDIUM";
  return "LOW";
}

export interface DeciderStateStats {
  stateChars: number;
  bugReportChars: number;
  bugReportTruncated: boolean;
}

export function buildDeciderState(bugText: string): { state: string; stats: DeciderStateStats } {
  const bug = bugText.trim();
  const bugReportTruncated = bug.length > BUG_REPORT_MAX_CHARS;
  const body = bugReportTruncated ? `${bug.slice(0, BUG_REPORT_MAX_CHARS)}\n[truncated]` : bug;
  const state = `<bug-report>\n${body}\n</bug-report>\n`;
  return {
    state,
    stats: { stateChars: state.length, bugReportChars: bug.length, bugReportTruncated },
  };
}

interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

export function buildDeciderRequest(state: string): {
  state: string;
  questions: Record<string, NoulQuestion>;
} {
  const questions: Record<string, NoulQuestion> = {};
  for (const check of DECIDER_CHECKS) {
    questions[check.id] = {
      type: "noul",
      instructions: check.question,
      criteria: { true: check.whenTrue, false: check.whenFalse },
    };
  }
  return { state, questions };
}

/**
 * The text the model reads for one question, exactly as strands-decider 0.2.0 renders it
 * (strands_decider/prompting.py: render_state + render_question for a noul). Shown in the UI.
 */
export function renderDeciderPrompt(state: string, question: NoulQuestion): string {
  return renderStateBlock(state) + renderQuestionBlock(question);
}

/** The shared part of every prompt; the server encodes it once per request. */
export function renderStateBlock(state: string): string {
  return `<state>\n${state.trim()}\n</state>\n`;
}

/** The part of one prompt that is specific to one question. */
export function renderQuestionBlock(question: NoulQuestion): string {
  const line = (n: number, name: string, desc: string) => {
    const flat = desc.split(/\s+/).filter(Boolean).join(" ");
    return `${n}. ${name}${flat ? ` \u2014 ${flat}` : ""}`;
  };
  return (
    `<question type="noul">\nDecide whether the statement is true of the state.\n` +
    `${question.instructions.trim()}\n<options>\n` +
    `${line(1, "false", question.criteria.false.trim())}\n${line(2, "true", question.criteria.true.trim())}\n` +
    `</options>\n</question>\n<answer>`
  );
}

/** What the run record keeps so the UI can show the prompt exactly as the model read it. */
export interface DeciderPromptRecord {
  stateBlock: string;
  questions: Array<{ id: string; label: string; block: string }>;
  /** The JSON body sent to the endpoint. */
  request: ReturnType<typeof buildDeciderRequest>;
}

export function deciderPromptRecord(request: ReturnType<typeof buildDeciderRequest>): DeciderPromptRecord {
  return {
    stateBlock: renderStateBlock(request.state),
    questions: DECIDER_CHECKS.map((check) => ({
      id: check.id,
      label: check.label,
      block: renderQuestionBlock(request.questions[check.id]),
    })),
    request,
  };
}

export interface DeciderCheckResult {
  id: string;
  label: string;
  /** Probability the model gives to "true". */
  pTrue: number;
  /** Probability that this check keeps the fix SIMPLE. */
  pSimple: number;
  passes: boolean;
  text: string;
}

export interface DeciderAnswer {
  verdict: Complexity;
  /** How likely the verdict is: see deciderVerdict. */
  probability: number;
  certainty: Certainty;
  checks: DeciderCheckResult[];
  /** The check that decided the verdict: the weakest pass, or the strongest failure. */
  decidingCheck: string;
  modelId: string;
  inputTokens: number | null;
  serverLatencyMs: number | null;
}

/**
 * SIMPLE needs every check to pass, so it is as likely as its least likely check. COMPLEX needs
 * one failing check, so it is as likely as its most likely failing check.
 */
export function deciderVerdict(checks: DeciderCheckResult[]): {
  verdict: Complexity;
  probability: number;
  decidingCheck: string;
} {
  const failing = checks.filter((c) => !c.passes);
  if (failing.length > 0) {
    const strongest = failing.reduce((a, b) => (1 - b.pSimple > 1 - a.pSimple ? b : a));
    return { verdict: "COMPLEX", probability: 1 - strongest.pSimple, decidingCheck: strongest.id };
  }
  const weakest = checks.reduce((a, b) => (b.pSimple < a.pSimple ? b : a));
  return { verdict: "SIMPLE", probability: weakest.pSimple, decidingCheck: weakest.id };
}

export class DeciderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeciderResponseError";
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeciderResponseError(`${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function unitInterval(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DeciderResponseError(`${what} must be a number from 0 through 1`);
  }
  return value;
}

/** Strictly validate the System One response; anything unexpected is an error, never a guess. */
export function parseDeciderResponse(body: unknown): DeciderAnswer {
  const response = record(body, "decider response");
  const answers = record(response.answers, "decider response answers");
  const expected = DECIDER_CHECKS.map((c) => c.id).sort();
  if (Object.keys(answers).sort().join(",") !== expected.join(",")) {
    throw new DeciderResponseError(`decider response must answer exactly: ${expected.join(", ")}`);
  }
  const checks: DeciderCheckResult[] = DECIDER_CHECKS.map((check) => {
    const answer = record(answers[check.id], `${check.id} answer`);
    if (answer.type !== "noul") throw new DeciderResponseError(`${check.id} answer must be a noul`);
    const pTrue = unitInterval(answer.noul, `${check.id} probability`);
    const pSimple = check.simpleWhen ? pTrue : 1 - pTrue;
    const passes = pSimple >= 0.5;
    return {
      id: check.id,
      label: check.label,
      pTrue,
      pSimple,
      passes,
      text: passes ? check.simpleText : check.complexText,
    };
  });
  const { verdict, probability, decidingCheck } = deciderVerdict(checks);

  const model =
    typeof response.model === "string" ? response.model.replace(/[^\w.@:/-]/g, "").slice(0, 120) : "";
  const usage =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : {};
  const inputTokens =
    Number.isInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0
      ? Number(usage.input_tokens)
      : null;
  const latency = response.latency_ms;
  const serverLatencyMs =
    typeof latency === "number" && Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null;

  return {
    verdict,
    probability,
    certainty: certaintyOf(probability),
    checks,
    decidingCheck,
    modelId: model || "unknown",
    inputTokens,
    serverLatencyMs,
  };
}

export type DeciderErrorCode =
  | "DECIDER_INPUT_FAILED"
  | "DECIDER_NOT_DEPLOYED"
  | "DECIDER_NOT_READY"
  | "DECIDER_ACCESS_DENIED"
  | "DECIDER_MODEL_ERROR"
  | "DECIDER_THROTTLED"
  | "DECIDER_TIMEOUT"
  | "DECIDER_INVALID_RESPONSE"
  | "DECIDER_REQUEST_FAILED";

export interface ClassifiedDeciderError {
  code: DeciderErrorCode;
  /** UNAVAILABLE: the endpoint is absent or not serving. FAILED: it was reached and failed. */
  status: "UNAVAILABLE" | "FAILED";
  message: string;
}

function sanitize(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return (
    text
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/arn:(?:aws[a-zA-Z-]*)?:[^\s,;]+/g, "[resource]")
      .replace(/\b\d{12}\b/g, "[account]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300) || "decision model request failed"
  );
}

/**
 * Map SageMaker Runtime errors (ValidationError, ModelError, ModelNotReadyException,
 * ServiceUnavailable, InternalFailure, ...) to a stable code and a sanitized message.
 */
export function classifyDeciderError(error: unknown): ClassifiedDeciderError {
  if (error instanceof DeciderResponseError) {
    return { code: "DECIDER_INVALID_RESPONSE", status: "FAILED", message: sanitize(error.message) };
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "";
  const message = sanitize(record.message);
  if (name === "AbortError" || name === "TimeoutError") {
    return { code: "DECIDER_TIMEOUT", status: "FAILED", message: "decision model did not answer in time" };
  }
  if (name === "ValidationError" || name === "ValidationException") {
    // InvokeEndpoint reports a missing endpoint as a validation error.
    if (/endpoint .*not found|could not find endpoint/i.test(message)) {
      return {
        code: "DECIDER_NOT_DEPLOYED",
        status: "UNAVAILABLE",
        message: "decision model endpoint is not deployed (start it in Settings)",
      };
    }
    if (/status|not in service|creating|deleting|updating/i.test(message)) {
      return {
        code: "DECIDER_NOT_READY",
        status: "UNAVAILABLE",
        message: "decision model endpoint is not in service yet",
      };
    }
    return { code: "DECIDER_REQUEST_FAILED", status: "FAILED", message };
  }
  if (name === "ModelNotReadyException" || name === "ServiceUnavailable") {
    return {
      code: "DECIDER_NOT_READY",
      status: "UNAVAILABLE",
      message: "decision model endpoint is not ready",
    };
  }
  if (name === "AccessDeniedException") {
    return {
      code: "DECIDER_ACCESS_DENIED",
      status: "FAILED",
      message: "access to the decision model endpoint was denied",
    };
  }
  if (name === "ThrottlingException") {
    return {
      code: "DECIDER_THROTTLED",
      status: "FAILED",
      message: "decision model endpoint is throttling requests",
    };
  }
  if (name === "ModelError" && /invocation timed out/i.test(String(record.message ?? ""))) {
    // SageMaker ends a real-time invocation after 60 seconds and reports it as a ModelError.
    return {
      code: "DECIDER_TIMEOUT",
      status: "FAILED",
      message: "decision model took longer than SageMaker's 60-second invocation limit (long bug report)",
    };
  }
  if (name === "ModelError") {
    const original =
      typeof record.OriginalStatusCode === "number" ? ` (HTTP ${record.OriginalStatusCode})` : "";
    return {
      code: "DECIDER_MODEL_ERROR",
      status: "FAILED",
      message: sanitize(
        `decision model rejected the request${original}: ${String(record.OriginalMessage ?? message)}`
      ),
    };
  }
  return { code: "DECIDER_REQUEST_FAILED", status: "FAILED", message };
}
