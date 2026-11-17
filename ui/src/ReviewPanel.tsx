import { useState } from "react";
import { api } from "./api";
import type { ReviewAction, Run } from "./types";
import {
  optionalString,
  safeArray,
  safeNonNegativeNumber,
  safeObjectArray,
  safeRecord,
  safeString,
  safeDateTime,
} from "./safe";

/** Mirrors infra/lambdas/shared/review.ts. */
const MIN_REASON_CHARS = 10;
const MAX_REASON_CHARS = 2_000;
const MAX_GUIDANCE_CHARS = 4_000;
const MAX_ARTIFACT_CHARS = 50_000;

const VERDICT_TEXT: Record<string, string> = {
  PASSED: "The fix branch builds.",
  PRE_EXISTING_ONLY: "The build still fails, but only with errors that already fail the base commit. The fix adds none.",
  NEW_ERRORS: "The fix adds build errors that the base commit does not have.",
  FAILED_UNCOMPARABLE: "The build failed, and its errors could not be compared with the base commit's build.",
};

function strings(value: unknown): string[] {
  return safeArray<unknown>(value).filter((v): v is string => typeof v === "string");
}

/** The evidence a reviewer decides on: build comparison, validator checks, the last attempt. */
function ReviewEvidence({ run, onInspectFix }: { run: Run; onInspectFix: (runId: string) => void }) {
  const runId = optionalString(run.runId);
  const validation = safeRecord(run.validation);
  const gate = safeRecord(validation?.buildGate);
  const verdict = optionalString(gate?.verdict);
  const newErrors = strings(gate?.newErrors);
  const preExisting = strings(gate?.preExistingErrors);
  const checks = safeObjectArray<Record<string, unknown>>(validation?.checks);
  const issues = strings(validation?.issues);
  const implementation = safeRecord(run.implementResult);
  const hasFix = typeof run.fixCommitId === "string" && run.fixCommitId.length === 40;
  return (
    <div className="review-evidence">
      <div className="review-evidence-block">
        <h4>Build</h4>
        <p className={verdict === "PASSED" || verdict === "PRE_EXISTING_ONLY" ? "text-pass" : "text-fail"}>
          {verdict ? VERDICT_TEXT[verdict] ?? verdict : "No build result was recorded for the last attempt."}
        </p>
        {newErrors.length > 0 && (
          <>
            <span className="muted small">Added by the fix</span>
            <ul className="review-errors new">{newErrors.map((e) => <li key={e}><code>{e}</code></li>)}</ul>
          </>
        )}
        {preExisting.length > 0 && (
          <>
            <span className="muted small">Pre-existing on the base commit (out of scope)</span>
            <ul className="review-errors">{preExisting.map((e) => <li key={e}><code>{e}</code></li>)}</ul>
          </>
        )}
      </div>

      <div className="review-evidence-block">
        <h4>
          Validator checks
          {validation?.modelReviewed === false && <span className="muted small"> · the validator could not review a diff</span>}
        </h4>
        {checks.length === 0 ? (
          <p className="muted">No checks were recorded.</p>
        ) : (
          <ul className="review-checks">
            {checks.map((c, i) => (
              <li key={i} className={c.pass === true ? "pass" : "fail"}>
                <span aria-hidden="true">{c.pass === true ? "✓" : "✕"}</span>
                <span><strong>{safeString(c.requirement, "check")}</strong> {safeString(c.note, "")}</span>
              </li>
            ))}
          </ul>
        )}
        {issues.length > 0 && (
          <details className="review-details">
            <summary>Validator findings ({issues.length})</summary>
            <ul>{issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
          </details>
        )}
      </div>

      <div className="review-evidence-block">
        <h4>Last attempt</h4>
        <p className="review-summary">{safeString(implementation?.summary, "No summary was recorded.")}</p>
        <div className="button-row">
          {hasFix ? (
            <button disabled={!runId} onClick={() => runId && onInspectFix(runId)}>
              Inspect the fix branch diff →
            </button>
          ) : (
            <span className="muted small">No fix commit exists yet, so there is no diff to inspect or accept.</span>
          )}
        </div>
      </div>
    </div>
  );
}

const ACTIONS: Array<{ id: ReviewAction; icon: string; title: string; blurb: string }> = [
  { id: "accept", icon: "✓", title: "Accept the fix", blurb: "Keep the fix branch as it is. Recorded as accepted by a reviewer, never as a green validation." },
  { id: "retry", icon: "↻", title: "Retry with guidance", blurb: "Tell Kiro what to do differently, optionally edit the approved artifact, and grant more attempts." },
  { id: "close", icon: "■", title: "Close the run", blurb: "End the run without accepting the fix. The fix branch is kept for inspection." },
];

export function ReviewPanel({
  run,
  onChanged,
  onInspectFix,
}: {
  run: Run;
  onChanged: () => void;
  onInspectFix: (runId: string) => void;
}) {
  const runId = optionalString(run.runId);
  const review = safeRecord(run.review);
  const canRetry = review?.canRetry === true;
  const maxAdditional = Math.max(1, safeNonNegativeNumber(review?.maxAdditionalAttempts) ?? 1);
  const hasFix = typeof run.fixCommitId === "string" && run.fixCommitId.length === 40;
  const approvedArtifact = optionalString(run.approvedArtifact) ?? optionalString(run.selectedArtifact) ?? "";
  const [action, setAction] = useState<ReviewAction>(hasFix ? "accept" : canRetry ? "retry" : "close");
  const [reason, setReason] = useState("");
  const [guidance, setGuidance] = useState("");
  const [attempts, setAttempts] = useState(1);
  const [editArtifact, setEditArtifact] = useState(false);
  const [artifact, setArtifact] = useState(approvedArtifact);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const disabledReason = (id: ReviewAction): string | null => {
    if (id === "accept" && !hasFix) return "No fix commit exists to accept.";
    if (id === "retry" && !canRetry) return safeString(review?.retryUnavailableReason, "Retry is not available.");
    return null;
  };
  const trimmedReason = reason.trim();
  const trimmedGuidance = guidance.trim();
  const valid =
    action === "accept"
      ? trimmedReason.length >= MIN_REASON_CHARS && trimmedReason.length <= MAX_REASON_CHARS
      : action === "retry"
        ? trimmedGuidance.length >= MIN_REASON_CHARS &&
          trimmedGuidance.length <= MAX_GUIDANCE_CHARS &&
          (!editArtifact || artifact.trim().length > 0)
        : trimmedReason.length <= MAX_REASON_CHARS;

  const submit = async () => {
    if (!runId || disabledReason(action) || !valid) return;
    setBusy(true);
    setError("");
    try {
      await api.reviewDecision(
        runId,
        action === "accept"
          ? { action, reason: trimmedReason }
          : action === "retry"
            ? {
                action,
                guidance: trimmedGuidance,
                additionalAttempts: attempts,
                ...(editArtifact && artifact !== approvedArtifact ? { artifact } : {}),
              }
            : { action, ...(trimmedReason ? { reason: trimmedReason } : {}) }
      );
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="approval review-gate card warn-border">
      <div className="gate-heading">
        <div>
          <span className="eyebrow gate-eyebrow">REVIEW GATE · ROUND {safeNonNegativeNumber(review?.round) ?? 1}</span>
          <h3>A decision is needed</h3>
        </div>
        <span className="recommendation-pill">
          Attempts used: {safeNonNegativeNumber(review?.attemptsUsed) ?? "—"}/{safeNonNegativeNumber(review?.attemptBudget) ?? "—"}
        </span>
      </div>
      <p>{safeString(review?.reason, "Automatic attempts could not finish this run.")}</p>
      <p className="muted small">
        If nobody decides, the run closes on its own on {safeDateTime(review?.expiresAt)}.
      </p>

      <ReviewEvidence run={run} onInspectFix={onInspectFix} />

      <div className="mode-card-grid review-actions" role="radiogroup" aria-label="Review decision">
        {ACTIONS.map((a) => {
          const blocked = disabledReason(a.id);
          return (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={action === a.id}
              disabled={blocked !== null}
              title={blocked ?? undefined}
              className={`mode-card ${action === a.id ? "selected" : ""}`}
              onClick={() => setAction(a.id)}
            >
              <span className="mode-icon">{a.icon}</span>
              <strong>{a.title}</strong>
              <small>{blocked ?? a.blurb}</small>
            </button>
          );
        })}
      </div>

      {action === "accept" && (
        <>
          <label className="field-label" htmlFor="review-reason">Why is this fix acceptable? (required)</label>
          <textarea
            id="review-reason"
            rows={3}
            maxLength={MAX_REASON_CHARS}
            placeholder="e.g. The only remaining build error is BUG-001, which is pre-existing; the diff to searchTodos is correct."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="muted small">
            The run is recorded as ACCEPTED BY REVIEWER with your name, your reason and the failed
            checks. If the run asked for a security review, it runs next on this fix.
          </p>
        </>
      )}

      {action === "retry" && (
        <>
          <label className="field-label" htmlFor="review-guidance">Guidance for Kiro (required)</label>
          <textarea
            id="review-guidance"
            rows={4}
            maxLength={MAX_GUIDANCE_CHARS}
            placeholder="e.g. Only change searchTodos; the completeTodo build error is out of scope."
            value={guidance}
            onChange={(e) => setGuidance(e.target.value)}
          />
          <div className="review-retry-options">
            <label>
              More attempts{" "}
              <select value={attempts} onChange={(e) => setAttempts(Number(e.target.value))}>
                {Array.from({ length: maxAdditional }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <label className="checkbox-inline">
              <input type="checkbox" checked={editArtifact} onChange={(e) => setEditArtifact(e.target.checked)} />
              Edit the approved artifact
            </label>
          </div>
          {editArtifact && (
            <>
              <textarea
                className="artifact-editor"
                rows={12}
                maxLength={MAX_ARTIFACT_CHARS}
                value={artifact}
                onChange={(e) => setArtifact(e.target.value)}
              />
              <p className="muted small">
                Saved as a new approved version; the earlier version stays on the run. Validation
                uses the new version from the next attempt on.
              </p>
            </>
          )}
        </>
      )}

      {action === "close" && (
        <>
          <label className="field-label" htmlFor="review-close">Note (optional)</label>
          <textarea
            id="review-close"
            rows={2}
            maxLength={MAX_REASON_CHARS}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </>
      )}

      {error && <p className="error">{error}</p>}
      <div className="button-row">
        <button
          className={action === "close" ? "danger" : "primary"}
          disabled={busy || !runId || !valid || disabledReason(action) !== null}
          onClick={() => void submit()}
        >
          {busy
            ? "Submitting…"
            : action === "accept"
              ? "Accept the fix"
              : action === "retry"
                ? `Retry with ${attempts} more attempt${attempts === 1 ? "" : "s"}`
                : "Close the run"}
        </button>
        {action !== "close" && !valid && (
          <span className="muted small">
            {action === "accept" ? "Write a reason" : "Write guidance"} of at least {MIN_REASON_CHARS} characters.
          </span>
        )}
      </div>
    </div>
  );
}

const ACTION_LABEL: Record<string, string> = {
  accept: "Accepted the fix",
  retry: "Asked for a retry",
  close: "Closed the run",
};

/** Every review decision on the run, oldest first. */
export function ReviewHistory({ run }: { run: Run }) {
  const decisions = safeObjectArray<Record<string, unknown>>(run.reviewDecisions);
  if (decisions.length === 0) return null;
  return (
    <section className="card review-history">
      <h3>Review decisions</h3>
      <ol>
        {decisions.map((d, i) => {
          const failed = strings(d.failedChecks);
          return (
            <li key={i}>
              <strong>
                Round {safeNonNegativeNumber(d.round) ?? i + 1}: {ACTION_LABEL[safeString(d.action, "")] ?? safeString(d.action)}
              </strong>{" "}
              <span className="muted small">
                by {safeString(d.reviewer, "a reviewer")} · {safeDateTime(d.decidedAt)} · after{" "}
                {safeNonNegativeNumber(d.attemptsAtDecision) ?? "?"} attempt(s)
              </span>
              {optionalString(d.reason) && <p>“{safeString(d.reason)}”</p>}
              {optionalString(d.guidance) && <p>Guidance: “{safeString(d.guidance)}”</p>}
              {safeNonNegativeNumber(d.additionalAttempts) !== null && (
                <p className="muted small">
                  {safeNonNegativeNumber(d.additionalAttempts)} more attempt(s)
                  {d.artifactEdited === true ? `; approved artifact edited (version ${safeNonNegativeNumber(d.artifactVersion)})` : ""}
                </p>
              )}
              {failed.length > 0 && <p className="muted small">Failed checks at the time: {failed.join(", ")}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
