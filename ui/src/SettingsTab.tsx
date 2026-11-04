import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { DeciderEndpointStatus, DeciderOverview, DeciderVariantId } from "./types";
import { optionalString, safeNonNegativeNumber, safeObjectArray, safeRecord, safeString } from "./safe";

/** Poll quickly while SageMaker is changing an endpoint, slowly otherwise. */
const FAST_POLL_MS = 10_000;
const SLOW_POLL_MS = 60_000;

function variantId(value: unknown): DeciderVariantId | null {
  return value === "cpu" || value === "gpu" ? value : null;
}

function parseEndpoint(value: unknown): DeciderEndpointStatus | null {
  const r = safeRecord(value);
  const variant = variantId(r?.variant);
  if (!r || !variant || !optionalString(r.state)) return null;
  return {
    variant,
    label: safeString(r.label, variant.toUpperCase()),
    active: r.active === true,
    endpointName: safeString(r.endpointName, ""),
    state: safeString(r.state, "UNKNOWN"),
    serving: r.serving === true,
    transitional: r.transitional === true,
    endpointConfigName: safeString(r.endpointConfigName, ""),
    deployedEndpointConfigName: optionalString(r.deployedEndpointConfigName),
    outOfDate: r.outOfDate === true,
    instanceType: safeString(r.instanceType, ""),
    modelId: safeString(r.modelId, ""),
    hourlyUsd: safeNonNegativeNumber(r.hourlyUsd),
    creationTime: optionalString(r.creationTime),
    lastModifiedTime: optionalString(r.lastModifiedTime),
    runningHours: safeNonNegativeNumber(r.runningHours),
    estimatedCostUsd: safeNonNegativeNumber(r.estimatedCostUsd),
    failureReason: optionalString(r.failureReason),
    canManage: r.canManage === true,
    canDeploy: r.canDeploy === true,
    canStop: r.canStop === true,
  };
}

function parseOverview(value: unknown): DeciderOverview | null {
  const r = safeRecord(value);
  const active = variantId(r?.activeVariant);
  if (!r || !active) return null;
  const variants = safeObjectArray<Record<string, unknown>>(r.variants)
    .map(parseEndpoint)
    .filter((v): v is DeciderEndpointStatus => v !== null);
  if (variants.length === 0) return null;
  return {
    activeVariant: active,
    activeVariantUpdatedAt: optionalString(r.activeVariantUpdatedAt),
    activeVariantUpdatedBy: optionalString(r.activeVariantUpdatedBy),
    canSelect: r.canSelect === true,
    variants,
  };
}

const STATE_COPY: Record<string, { badge: string; tone: "ok" | "warn" | "bad" | "info"; text: string }> = {
  NOT_DEPLOYED: { badge: "STOPPED", tone: "info", text: "No endpoint is running and nothing is billed." },
  Creating: { badge: "STARTING", tone: "warn", text: "SageMaker is getting an instance, copying the weights and loading the model. Billing starts once the instance is up." },
  InService: { badge: "RUNNING", tone: "ok", text: "The endpoint is serving." },
  Updating: { badge: "UPDATING", tone: "warn", text: "SageMaker is updating the endpoint; it keeps serving meanwhile." },
  SystemUpdating: { badge: "UPDATING", tone: "warn", text: "SageMaker is applying a system update; the endpoint keeps serving meanwhile." },
  RollingBack: { badge: "ROLLING BACK", tone: "warn", text: "SageMaker is rolling back an update." },
  Deleting: { badge: "STOPPING", tone: "warn", text: "SageMaker is deleting the endpoint. Billing ends when the instance is released." },
  OutOfService: { badge: "OUT OF SERVICE", tone: "bad", text: "The endpoint cannot serve requests. Stop it and deploy again." },
  Failed: { badge: "FAILED", tone: "bad", text: "The endpoint failed to start. Stop (delete) it before deploying again." },
  UpdateRollbackFailed: { badge: "FAILED", tone: "bad", text: "An update rollback failed. Stop it and deploy again." },
  UNKNOWN: { badge: "UNKNOWN", tone: "bad", text: "The endpoint reported a status this app does not recognise." },
};

const VARIANT_BLURB: Record<DeciderVariantId, string> = {
  cpu: "Cheaper per hour, slow: about 20 s for a short bug report, and long reports can pass SageMaker's 60-second limit.",
  gpu: "One NVIDIA L40S GPU: expected to answer in seconds, at a higher hourly price. AWS sometimes has no free GPU instance; the start then fails with InsufficientInstanceCapacity and can be retried later.",
};

function copyOf(state: string) {
  return STATE_COPY[state] ?? STATE_COPY.UNKNOWN;
}

function usd(value: number | null, digits = 2): string {
  return value === null ? "Unavailable" : `$${value.toFixed(digits)}`;
}

function duration(hours: number | null): string {
  if (hours === null) return "—";
  const minutes = Math.round(hours * 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

type Pending = { action: "deploy" | "stop"; variant: DeciderVariantId } | null;

function PipelineChoice({
  overview,
  busy,
  onSelect,
}: {
  overview: DeciderOverview;
  busy: boolean;
  onSelect: (variant: DeciderVariantId) => void;
}) {
  const active = overview.variants.find((v) => v.active) ?? null;
  const running = overview.variants.filter((v) => v.state !== "NOT_DEPLOYED");
  const idleRunning = running.filter((v) => !v.active);
  return (
    <section className="card settings-card" aria-labelledby="decider-choice-title">
      <div className="settings-card-heading">
        <div>
          <span className="eyebrow settings-eyebrow">DECISION MODEL</span>
          <h3 id="decider-choice-title">Endpoint used by the pipeline</h3>
          <p className="muted">
            The same Strands Decider model can run on a CPU or a GPU endpoint. Both can be
            running, but new runs use only the one picked here; runs already started keep theirs.
          </p>
        </div>
      </div>
      <div className="decider-choice" role="radiogroup" aria-labelledby="decider-choice-title">
        {overview.variants.map((v) => {
          const copy = copyOf(v.state);
          return (
            <label key={v.variant} className={`decider-choice-option ${v.active ? "selected" : ""}`}>
              <input
                type="radio"
                name="decider-variant"
                value={v.variant}
                checked={v.active}
                disabled={busy || !overview.canSelect}
                onChange={() => onSelect(v.variant)}
              />
              <span className="decider-choice-text">
                <strong>
                  {v.label} endpoint <code>{v.instanceType}</code>
                </strong>
                <small>
                  {usd(v.hourlyUsd, 3)} per hour while running. {VARIANT_BLURB[v.variant]}
                </small>
              </span>
              <span className={`badge ${copy.tone}`}>{copy.badge}</span>
            </label>
          );
        })}
      </div>
      {active && !active.serving && (
        <div className="notice warn-notice" role="status">
          New runs cannot use the decision model until the {active.label} endpoint is running.
          {active.state === "NOT_DEPLOYED" ? " Deploy it below." : ""}
        </div>
      )}
      {active && idleRunning.length > 0 && (
        <div className="notice warn-notice" role="status">
          The {idleRunning.map((v) => v.label).join(" and ")} endpoint is also running and billed
          {idleRunning[0].hourlyUsd !== null ? ` (${usd(idleRunning[0].hourlyUsd, 3)} per hour)` : ""}, but
          the pipeline uses the {active.label} one. Stop it below if you do not need it.
        </div>
      )}
      {overview.activeVariantUpdatedBy && overview.activeVariantUpdatedAt && (
        <p className="muted small">
          Last changed by {overview.activeVariantUpdatedBy} on{" "}
          {new Date(overview.activeVariantUpdatedAt).toLocaleString()}.
        </p>
      )}
      {!overview.canSelect && (
        <p className="muted small">
          Your session could not be identified, so changes are disabled. Sign out and sign in again.
        </p>
      )}
    </section>
  );
}

function EndpointPanel({
  status,
  busy,
  onAction,
}: {
  status: DeciderEndpointStatus;
  busy: boolean;
  onAction: (action: "deploy" | "stop", variant: DeciderVariantId) => void;
}) {
  const copy = copyOf(status.state);
  const hourly = status.hourlyUsd;
  const titleId = `decider-endpoint-${status.variant}-title`;
  return (
    <section className={`card settings-card ${status.active ? "settings-card-active" : ""}`} aria-labelledby={titleId}>
      <div className="settings-card-heading">
        <div>
          <span className="eyebrow settings-eyebrow">
            {status.label} ENDPOINT{status.active ? " · USED BY THE PIPELINE" : ""}
          </span>
          <h3 id={titleId}>
            Strands Decider on {status.label} (<code>{status.instanceType || "unknown"}</code>)
          </h3>
          <p className="muted">
            {VARIANT_BLURB[status.variant]} It is not created by deployment: start it when you
            need it and stop it when you are done, because it is billed for every hour it exists.
          </p>
        </div>
        <span className={`badge big ${copy.tone}`}>{copy.badge}</span>
      </div>

      <p className="settings-state-text">{copy.text}</p>
      {status.failureReason && (
        <div className="notice error-notice" role="alert">
          <strong>Failure reason:</strong> {status.failureReason}
        </div>
      )}
      {status.outOfDate && (
        <div className="notice warn-notice" role="status">
          This endpoint was created from an older configuration
          (<code>{status.deployedEndpointConfigName}</code>). Stop it and deploy again to use the
          current one.
        </div>
      )}

      <dl className="settings-grid">
        <div><dt>Status</dt><dd>{status.state === "NOT_DEPLOYED" ? "Not deployed" : status.state}</dd></div>
        <div><dt>Endpoint</dt><dd><code>{status.endpointName}</code></dd></div>
        <div><dt>Instance type</dt><dd><code>{status.instanceType || "Unavailable"}</code></dd></div>
        <div><dt>Hourly price</dt><dd>{hourly === null ? "Unavailable for this Region" : `${usd(hourly, 3)} per hour (~${usd(hourly * 24)} per day)`}</dd></div>
        <div><dt>Running for</dt><dd>{duration(status.runningHours)}</dd></div>
        <div><dt>Estimated cost so far</dt><dd>{status.estimatedCostUsd === null ? "—" : `${usd(status.estimatedCostUsd)} (estimate)`}</dd></div>
        <div className="settings-wide"><dt>Model</dt><dd><code>{status.modelId || "Unavailable"}</code></dd></div>
        <div className="settings-wide"><dt>Endpoint configuration</dt><dd><code>{status.endpointConfigName || "Unavailable"}</code></dd></div>
        {status.creationTime && (
          <div className="settings-wide"><dt>Created</dt><dd>{new Date(status.creationTime).toLocaleString()}</dd></div>
        )}
      </dl>

      <div className="button-row settings-actions">
        <button className="primary" disabled={busy || !status.canDeploy} onClick={() => onAction("deploy", status.variant)}>
          Deploy {status.label} endpoint
        </button>
        <button className="danger" disabled={busy || !status.canStop} onClick={() => onAction("stop", status.variant)}>
          Stop (delete) {status.label} endpoint
        </button>
      </div>
    </section>
  );
}

export function SettingsTab() {
  const [overview, setOverview] = useState<DeciderOverview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Pending>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const active = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const parsed = parseOverview(await api.getDeciderEndpoints());
      if (!active.current) return;
      if (!parsed) throw new Error("The endpoint status response is malformed.");
      setOverview(parsed);
      setLoadError("");
      setCheckedAt(new Date());
    } catch (e) {
      if (active.current) setLoadError(`Endpoint status unavailable: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
    };
  }, [refresh]);

  const transitional = overview?.variants.some((v) => v.transitional) ?? false;
  useEffect(() => {
    const timer = setTimeout(() => void refresh(), transitional ? FAST_POLL_MS : SLOW_POLL_MS);
    return () => clearTimeout(timer);
  }, [refresh, transitional, checkedAt]);

  const apply = (result: unknown) => {
    const parsed = parseOverview(result);
    if (parsed) setOverview(parsed);
    setCheckedAt(new Date());
  };

  const act = async (pending: NonNullable<Pending>) => {
    setBusy(true);
    setActionError("");
    setNotice("");
    const label = overview?.variants.find((v) => v.variant === pending.variant)?.label ?? pending.variant.toUpperCase();
    try {
      apply(
        pending.action === "deploy"
          ? await api.deployDeciderEndpoint(pending.variant)
          : await api.stopDeciderEndpoint(pending.variant)
      );
      setNotice(
        pending.action === "deploy"
          ? `${label} deployment started. This page refreshes every 10 seconds until the endpoint is InService.`
          : `Stop requested. SageMaker is deleting the ${label} endpoint; billing ends when the instance is released.`
      );
    } catch (e) {
      setActionError(String(e));
      void refresh();
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const select = async (variant: DeciderVariantId) => {
    if (overview?.activeVariant === variant) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      apply(await api.selectDeciderVariant(variant));
      setNotice(`New runs use the ${variant.toUpperCase()} endpoint. Runs already started keep theirs.`);
    } catch (e) {
      setActionError(String(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  };

  const target = confirm && overview?.variants.find((v) => v.variant === confirm.variant);
  const hourly = target?.hourlyUsd ?? null;

  return (
    <section className="context-page">
      <div className="context-hero">
        <div>
          <span className="eyebrow">SETTINGS</span>
          <h2>Settings</h2>
          <p>Optional, billed resources that the pipeline can use on demand.</p>
        </div>
      </div>

      {loadError && <div className="notice error-notice" role="alert">{loadError}</div>}
      {!overview && !loadError && <p className="muted">Checking the endpoints…</p>}
      {notice && <div className="notice success" role="status">{notice}</div>}
      {actionError && <div className="notice error-notice" role="alert">{actionError}</div>}

      {overview && (
        <>
          <PipelineChoice overview={overview} busy={busy} onSelect={(v) => void select(v)} />
          {overview.variants.map((v) => (
            <EndpointPanel key={v.variant} status={v} busy={busy} onAction={(action, variant) => setConfirm({ action, variant })} />
          ))}
          <div className="button-row settings-actions">
            <button disabled={busy} onClick={() => void refresh()}>Refresh status</button>
            <span className="muted small">
              {checkedAt ? `Checked ${checkedAt.toLocaleTimeString()}` : ""}
              {transitional ? " · refreshing every 10 s" : ""}
            </span>
          </div>
        </>
      )}

      {confirm && target && (
        <div className="modal-backdrop" role="presentation">
          <div className="reset-modal" role="dialog" aria-modal="true" aria-labelledby="decider-confirm-title">
            <span className="modal-icon settings-modal-icon">{confirm.action === "deploy" ? "▶" : "■"}</span>
            <h3 id="decider-confirm-title">
              {confirm.action === "deploy"
                ? `Deploy the ${target.label} decision model endpoint?`
                : `Stop (delete) the ${target.label} endpoint?`}
            </h3>
            {confirm.action === "deploy" ? (
              <p>
                This starts one <code>{target.instanceType}</code> SageMaker instance
                {hourly === null ? "" : ` at ${usd(hourly, 3)} per hour (about ${usd(hourly * 24)} per day)`},
                billed until you stop it, whether or not runs use it. Startup takes about 10 minutes.
                {!target.active && ` The pipeline uses the ${overview?.activeVariant.toUpperCase()} endpoint; pick ${target.label} above to make runs use this one.`}
              </p>
            ) : (
              <p>
                This deletes <code>{target.endpointName}</code> and stops its billing.
                {target.active
                  ? " The pipeline uses this endpoint, so runs that ask for a second opinion meanwhile record it as unavailable and continue with the LLM triage."
                  : ""}{" "}
                The configuration and weights stay, so you can deploy it again.
              </p>
            )}
            <div className="button-row">
              <button onClick={() => setConfirm(null)} disabled={busy}>Cancel</button>
              <button
                className={confirm.action === "deploy" ? "primary" : "danger"}
                disabled={busy}
                onClick={() => void act(confirm)}
              >
                {busy ? "Working…" : confirm.action === "deploy" ? "Deploy and start billing" : "Stop endpoint"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
