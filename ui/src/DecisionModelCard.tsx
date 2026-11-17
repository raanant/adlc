import type { ExecutionMode, Run } from "./types";
import {
  displayStatus,
  optionalString,
  safeNonNegativeNumber,
  safeObjectArray,
  safeRecord,
  safeString,
} from "./safe";

/**
 * The decision model's informative second opinion: a verdict, how likely it is, the five checks
 * behind it, how the model works, and (on request) the exact prompt it read. Display only:
 * routing always follows the LLM triage.
 */

type Certainty = "HIGH" | "MEDIUM" | "LOW";

interface CheckView {
  id: string;
  label: string;
  passes: boolean;
  /** How sure the model is about this check's outcome (0.5 to 1). */
  sure: number;
  text: string;
}

interface PromptView {
  stateBlock: string;
  questions: Array<{ id: string; label: string; block: string }>;
  requestJson: string;
}

export interface DecisionModelView {
  status: string;
  verdict: ExecutionMode | null;
  llmVerdict: ExecutionMode | null;
  /** How likely the verdict is (0.5 to 1). */
  probability: number | null;
  certainty: Certainty | null;
  checks: CheckView[];
  decidingCheck: string | null;
  agrees: boolean | null;
  modelId: string | null;
  /** "CPU" or "GPU": the endpoint that answered (picked in Settings when the run started). */
  variantLabel: string | null;
  instanceType: string | null;
  serverLatencyMs: number | null;
  roundTripMs: number | null;
  inputTokens: number | null;
  bugReportTruncated: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  prompt: PromptView | null;
  /** Runs recorded before the five checks asked one broad SIMPLE/COMPLEX question. */
  legacy: boolean;
}

function executionMode(value: unknown): ExecutionMode | null {
  return value === "SIMPLE" || value === "COMPLEX" ? value : null;
}

function unit(value: unknown): number | null {
  const number = safeNonNegativeNumber(value);
  return number !== null && number <= 1 ? number : null;
}

function certaintyOf(p: number | null): Certainty | null {
  if (p === null) return null;
  return p >= 0.95 ? "HIGH" : p >= 0.75 ? "MEDIUM" : "LOW";
}

function promptView(value: unknown): PromptView | null {
  const record = safeRecord(value);
  if (!record) return null;
  const questions = safeObjectArray<Record<string, unknown>>(record.questions)
    .map((q) => ({ id: safeString(q.id, ""), label: safeString(q.label, ""), block: safeString(q.block, "") }))
    .filter((q) => q.block);
  const stateBlock = optionalString(record.stateBlock);
  if (!stateBlock || questions.length === 0) return null;
  let requestJson = "";
  try {
    requestJson = JSON.stringify(record.request ?? null, null, 2);
  } catch {
    requestJson = "";
  }
  return { stateBlock, questions, requestJson };
}

/** Parse the stored record defensively; it is display-only data. */
export function decisionModelView(run: Run): DecisionModelView | null {
  const record = safeRecord(run.decisionModel);
  if (!record) return null;
  const error = safeRecord(record.error);
  const input = safeRecord(record.input);
  const verdict = executionMode(record.verdict);
  const checks: CheckView[] = safeObjectArray<Record<string, unknown>>(record.checks).flatMap((c) => {
    const pSimple = unit(c.pSimple);
    if (pSimple === null || typeof c.passes !== "boolean") return [];
    return [{
      id: safeString(c.id, ""),
      label: safeString(c.label, ""),
      passes: c.passes,
      sure: c.passes ? pSimple : 1 - pSimple,
      text: safeString(c.text, ""),
    }];
  });
  // Older runs stored probabilities of one broad question instead of checks.
  const legacyProbabilities = safeRecord(record.probabilities);
  const legacy = checks.length === 0 && legacyProbabilities !== null;
  const probability = legacy
    ? verdict ? unit(legacyProbabilities?.[verdict]) : null
    : unit(record.probability);
  return {
    status: safeString(record.status, "UNKNOWN"),
    verdict,
    llmVerdict: executionMode(record.llmVerdict) ?? executionMode(run.triage?.complexity),
    probability,
    certainty: certaintyOf(probability),
    checks,
    decidingCheck: optionalString(record.decidingCheck),
    agrees: typeof record.agreesWithLlm === "boolean" ? record.agreesWithLlm : null,
    modelId: optionalString(record.modelId),
    variantLabel: optionalString(record.variantLabel),
    instanceType: optionalString(record.instanceType),
    serverLatencyMs: safeNonNegativeNumber(record.serverLatencyMs),
    roundTripMs: safeNonNegativeNumber(record.roundTripMs),
    inputTokens: safeNonNegativeNumber(record.inputTokens),
    bugReportTruncated: input?.bugReportTruncated === true,
    errorCode: optionalString(error?.code),
    errorMessage: optionalString(error?.message),
    prompt: promptView(record.prompt),
    legacy,
  };
}

const CERTAINTY_WORD: Record<Certainty, string> = {
  HIGH: "high certainty",
  MEDIUM: "medium certainty",
  LOW: "low certainty",
};

const CERTAINTY_HINT: Record<Certainty, string> = {
  HIGH: "95% likely or more: the model is sure.",
  MEDIUM: "75–95% likely: a reasonable hint; check it against the artifact.",
  LOW: "Below 75%: the model is unsure; treat it as a weak hint.",
};

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function modeLabel(mode: ExecutionMode | null): string {
  return mode === "SIMPLE" ? "Simple" : mode === "COMPLEX" ? "Complex" : "Unavailable";
}

/** One sentence with the verdict, its likelihood and the comparison with the LLM. */
function headline(view: DecisionModelView): string {
  const comparison =
    view.agrees === true ? "agrees with the LLM" : view.agrees === false ? "disagrees with the LLM" : "no LLM verdict to compare";
  return `${modeLabel(view.verdict)}, ${pct(view.probability)} likely${view.certainty ? ` (${CERTAINTY_WORD[view.certainty]})` : ""} — ${comparison}`;
}

function CheckList({ view }: { view: DecisionModelView }) {
  if (view.checks.length === 0) return null;
  return (
    <ul className="decider-checks" aria-label="Decision model checks">
      {view.checks.map((check) => (
        <li key={check.id} className={`${check.passes ? "pass" : "fail"} ${check.id === view.decidingCheck ? "deciding" : ""}`}>
          <span className="decider-check-mark" aria-hidden="true">{check.passes ? "✓" : "✕"}</span>
          <span className="decider-check-text">
            <strong>{check.label}</strong> {check.text}
          </span>
          <span className="decider-check-sure" title="How sure the model is about this check">
            {pct(check.sure)} sure
          </span>
          <span className="decider-check-bar" aria-hidden="true">
            <span style={{ width: `${(check.sure * 100).toFixed(1)}%` }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function HowItWorks({ view }: { view: DecisionModelView }) {
  return (
    <details className="decider-details">
      <summary>How the decision model works</summary>
      <div className="decider-details-body">
        <p>
          A <strong>decision model</strong> does not write text. It reads a piece of text and, for
          each question, picks one of the answers it is given (here: true or false) and returns how
          likely each answer is. This one is Strands Decider{view.modelId ? <> (<code>{view.modelId}</code>)</> : null},
          an open model trained to answer narrow, typed questions. It runs on a private SageMaker
          endpoint, on CPU or GPU as picked in Settings{view.variantLabel ? <> (this run: {view.variantLabel})</> : null};
          both run the same model, and the GPU is the faster of the two.
        </p>
        <ol>
          <li>
            <strong>What it reads.</strong> Only the bug report. It does not see the code, the LLM's
            verdict or its reasoning, so its answer is independent.
          </li>
          <li>
            <strong>What it is asked.</strong> Five yes/no checks, one per condition of the default
            triage guidance: new dependency, data-model change, API contract change, new component,
            and whether the fix is a small edit in fewer than 5 files. Narrow questions work better
            for a small model than one broad "is this simple?" question.
          </li>
          <li>
            <strong>How the verdict follows.</strong> SIMPLE needs every check to pass, so it is as
            likely as its least sure check. One failing check makes it COMPLEX, as likely as the
            most sure failing check. The check that decided it is highlighted.
          </li>
          <li>
            <strong>What the percentage means.</strong> The model's probabilities are calibrated: on
            short tasks it has not seen, answers it gives 95% or more are right about 95% of the time
            (upstream evaluation). High certainty is 95% or more, medium 75–95%, low below 75%.
          </li>
          <li>
            <strong>What it changes.</strong> Nothing. Routing, auto-execution and the gate
            recommendation follow the LLM triage; use this as a second opinion.
          </li>
        </ol>
        <p className="muted small">
          The checks follow the default triage guidance. If you edit the guidance on the start form,
          the LLM uses your text; the decision model keeps asking these five checks.
        </p>
      </div>
    </details>
  );
}

function PromptDetails({ prompt }: { prompt: PromptView }) {
  return (
    <details className="decider-details">
      <summary>Show the prompt the model read</summary>
      <div className="decider-details-body">
        <p className="muted small">
          Each check is one prompt: the shared state block followed by that check's question. The
          model encodes the state once and scores the two numbered options after{" "}
          <code>&lt;answer&gt;</code>. This is the exact text, rendered as strands-decider renders it.
        </p>
        <h5>Shared state (the bug report)</h5>
        <pre className="decider-prompt">{prompt.stateBlock}</pre>
        {prompt.questions.map((q) => (
          <div key={q.id}>
            <h5>Check: {q.label || q.id}</h5>
            <pre className="decider-prompt">{q.block}</pre>
          </div>
        ))}
        {prompt.requestJson && (
          <details className="decider-details nested">
            <summary>Raw request sent to the endpoint (JSON)</summary>
            <pre className="decider-prompt">{prompt.requestJson}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

/** Compact version for the execution gate. */
export function DecisionModelGateSummary({ view }: { view: DecisionModelView }) {
  if (view.status !== "COMPLETED" || !view.verdict) {
    return (
      <p className="decision-model-inline muted small">
        Decision model second opinion: {view.status === "RUNNING" ? "no result recorded" : "unavailable"} for
        this run{view.errorCode ? ` (${view.errorCode})` : ""}.
      </p>
    );
  }
  const failing = view.checks.filter((c) => !c.passes);
  return (
    <div className={`decision-model-gate ${view.agrees === false ? "disagree" : ""}`}>
      <strong>Decision model: {headline(view)}.</strong>
      {failing.length > 0 ? (
        <span> Failing checks: {failing.map((c) => `${c.label} (${pct(c.sure)} sure)`).join(", ")}.</span>
      ) : view.checks.length > 0 ? (
        <span> All five checks pass.</span>
      ) : null}
      {view.agrees === false && <span> Review the artifact before executing.</span>}
    </div>
  );
}

export function DecisionModelCard({ run }: { run: Run }) {
  const view = decisionModelView(run);
  if (!view) {
    if (run.decisionModelEnabled !== true) return null;
    return (
      <section className="card decision-model-card" aria-labelledby="decision-model-title">
        <div className="decision-model-heading">
          <div>
            <span className="eyebrow">INFORMATIVE SECOND OPINION</span>
            <h3 id="decision-model-title">Decision model</h3>
          </div>
          <span className="badge info">PENDING</span>
        </div>
        <p className="muted small">Runs right after the LLM triage.</p>
      </section>
    );
  }
  const status = optionalString(run.status);
  const stale = view.status === "RUNNING" && status !== "TRIAGING" && status !== "PENDING";
  const badge =
    view.status === "COMPLETED"
      ? view.agrees === false
        ? { cls: "warn", text: "DISAGREES" }
        : view.agrees === true
          ? { cls: "ok", text: "AGREES" }
          : { cls: "info", text: "COMPLETED" }
      : view.status === "RUNNING" && !stale
        ? { cls: "info", text: "RUNNING" }
        : { cls: "bad", text: stale ? "NO RESULT" : displayStatus(view.status) };

  return (
    <section className="card decision-model-card" aria-labelledby="decision-model-title">
      <div className="decision-model-heading">
        <div>
          <span className="eyebrow">INFORMATIVE SECOND OPINION</span>
          <h3 id="decision-model-title">Decision model</h3>
        </div>
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>

      {view.status === "COMPLETED" && view.verdict ? (
        <>
          <div className="decider-headline">
            <div className={`decider-verdict ${view.verdict.toLowerCase()}`}>
              <span>Decision model says</span>
              <strong>{modeLabel(view.verdict)}</strong>
            </div>
            <div className="decider-likelihood">
              <span>How likely</span>
              <strong>
                {pct(view.probability)}
                {view.certainty && <em className={`band-pill ${view.certainty.toLowerCase()}`}>{view.certainty}</em>}
              </strong>
            </div>
            <div className={`decider-llm ${view.agrees === false ? "disagree" : ""}`}>
              <span>LLM triage (drives routing)</span>
              <strong>{modeLabel(view.llmVerdict)}</strong>
            </div>
          </div>
          {view.certainty && <p className="decider-sentence muted">{CERTAINTY_HINT[view.certainty]}</p>}
          {view.legacy ? (
            <p className="muted small">
              This run was recorded before the five checks were introduced; it asked one broad
              SIMPLE/COMPLEX question.
            </p>
          ) : (
            <CheckList view={view} />
          )}
          <p className="muted small decision-model-meta">
            Model <code>{view.modelId ?? "unknown"}</code>
            {view.variantLabel && (
              <>
                {" "}· {view.variantLabel} endpoint{view.instanceType ? <> (<code>{view.instanceType}</code>)</> : null}
              </>
            )}
            {view.serverLatencyMs !== null && ` · ${(view.serverLatencyMs / 1000).toFixed(1)} s on the endpoint`}
            {view.inputTokens !== null && ` · ${view.inputTokens.toLocaleString()} input tokens`}
            {view.bugReportTruncated && " · bug report shortened to fit the model window"}
          </p>
        </>
      ) : view.status === "RUNNING" && !stale ? (
        <p className="muted">Asking the decision model…</p>
      ) : (
        <p className="muted">
          {stale
            ? "No result was recorded: the step was interrupted."
            : `${view.status === "UNAVAILABLE" ? "Unavailable" : "Failed"}${view.errorCode ? ` (${view.errorCode})` : ""}: ${view.errorMessage ?? "no details recorded"}.`}{" "}
          The run continued with the LLM triage.
        </p>
      )}

      <HowItWorks view={view} />
      {view.prompt && <PromptDetails prompt={view.prompt} />}

      <p className="decision-model-note">
        Informative only. Routing, auto-execution and the execution gate recommendation follow the
        LLM triage verdict; this result never changes the pipeline.
      </p>
    </section>
  );
}
