import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { CodeCommitClient, GetBranchCommand } from "@aws-sdk/client-codecommit";
import { appendEvent, getRun, incrementCounter, updateRun } from "../shared/db";
import {
  type ExecutionMode,
  validateArtifact,
} from "../shared/workflow";
import {
  acquireImplementationLease,
  releaseImplementationLease,
} from "../shared/repo-control";

const client = new BedrockAgentCoreClient({});
const codecommit = new CodeCommitClient({});
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN!;
const REPO_NAME = process.env.REPO_NAME!;
const BASE_BRANCH = process.env.BASE_BRANCH ?? "main";

type UsageStatus = "COMPLETE" | "PARTIAL" | "UNAVAILABLE" | "NOT_APPLICABLE";

export interface ImplementResult {
  ok: boolean;
  engine: string;
  requestedModel: string;
  actualModel: string;
  executionMode: ExecutionMode;
  summary: string;
  filesChanged: string[];
  buildOk: boolean;
  buildOutput: string;
  fixBranch: string;
  baseCommitId: string;
  fixCommitId?: string;
  costUsd: number;
  attempt: number;
  kiroCredits: number | null;
  kiroCreditsStatus: UsageStatus;
  requestedRuntimeSessionId: string;
  returnedRuntimeSessionId?: string;
  traceId?: string;
  cpuSeconds?: number | null;
  peakMemoryBytes?: number | null;
  usageStartTimestamp?: string;
  usageEndTimestamp?: string;
  agentCoreUsageStatus?: UsageStatus;
  agentCoreUsageSource?: string;
  error?: string;
  /** Normalized build error lines of this attempt (see shared/build-gate.ts). */
  buildErrors?: string[];
  /** The fix was already on the branch from an earlier attempt; nothing new was committed. */
  noNewChanges?: boolean;
  /** The run's base-commit build, as measured before Kiro edited anything. */
  baselineBuild?: BaselineBuild;
}

export interface BaselineBuild {
  ok: boolean;
  errors: string[];
  commitId?: string;
  outputTail?: string;
}

function baselineOf(value: unknown): BaselineBuild | undefined {
  const r = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!r || typeof r.ok !== "boolean") return undefined;
  return {
    ok: r.ok,
    errors: Array.isArray(r.errors) ? r.errors.filter((e): e is string => typeof e === "string").slice(0, 50) : [],
    ...(typeof r.commitId === "string" ? { commitId: r.commitId } : {}),
    ...(typeof r.outputTail === "string" ? { outputTail: r.outputTail.slice(-1500) } : {}),
  };
}

/** Guidance from every "retry with guidance" review decision, oldest first. */
function reviewerGuidanceOf(run: Record<string, unknown> | undefined): string[] {
  const decisions = Array.isArray(run?.reviewDecisions) ? run.reviewDecisions : [];
  return decisions
    .map((d) => (d && typeof d === "object" ? (d as Record<string, unknown>) : {}))
    .filter((d) => d.action === "retry" && typeof d.guidance === "string" && d.guidance.trim())
    .map((d) => String(d.guidance));
}

export const handler = async (event: {
  runId: string;
  bugText: string;
  kiroModel?: string;
  executionMode?: ExecutionMode;
  approvedArtifact?: string;
  validation?: { issues?: string[] };
}): Promise<ImplementResult> => {
  const { runId, bugText } = event;
  const executionMode = event.executionMode ?? "SIMPLE";
  const approvedArtifact = event.approvedArtifact ?? "";
  if (executionMode !== "SIMPLE" && executionMode !== "COMPLEX") {
    throw new Error("executionMode must be SIMPLE or COMPLEX");
  }
  const artifactError = validateArtifact(executionMode, approvedArtifact);
  if (artifactError) throw new Error(artifactError);

  const attempt = await incrementCounter(runId, "fixAttempts");
  const runtimeSessionId = `${runId}-implement-${String(attempt).padStart(3, "0")}-session`;
  const fixBranch = `fix/${runId}`;
  const existingRun = await getRun(runId);
  // Prefer kiroModel from DB (may have been updated after triage recommendation)
  const kiroModel =
    (typeof existingRun?.kiroModel === "string" && existingRun.kiroModel.trim())
      ? existingRun.kiroModel.trim()
      : (event.kiroModel ?? "auto");
  const mcpConfig =
    typeof existingRun?.mcpConfig === "string" ? existingRun.mcpConfig : "";
  let baseCommitId = String(existingRun?.baseCommitId ?? "");
  if (!baseCommitId) {
    const branch = await codecommit.send(
      new GetBranchCommand({ repositoryName: REPO_NAME, branchName: BASE_BRANCH })
    );
    baseCommitId = branch.branch?.commitId ?? "";
    if (!baseCommitId) throw new Error("could not resolve the base commit");
  }

  await updateRun(runId, {
    status: "IMPLEMENTING",
    fixBranch,
    baseCommitId,
    executionMode,
    approvedArtifact,
  });
  const storedBaseline = baselineOf(existingRun?.baselineBuild);
  const reviewerGuidance = reviewerGuidanceOf(existingRun);
  await appendEvent(
    runId,
    "IMPLEMENT",
    attempt === 1
      ? `Coding agent implementing the approved ${executionMode} artifact (requested Kiro model: ${kiroModel})`
      : reviewerGuidance.length > 0
        ? `Attempt ${attempt}: coding agent retrying with reviewer guidance and the latest validation findings (${executionMode} artifact)`
        : `Fix loop iteration ${attempt}: coding agent addressing validation findings using the frozen ${executionMode} artifact`
  );

  await acquireImplementationLease(fixBranch);
  let result: ImplementResult;
  try {
    const payload = {
      action: "implement",
      runId,
      repoName: REPO_NAME,
      baseBranch: BASE_BRANCH,
      baseCommitId,
      fixBranch,
      bugText,
      kiroModel,
      mode: executionMode,
      artifact: approvedArtifact,
      validationIssues: event.validation?.issues ?? [],
      attempt,
      runtimeSessionId,
      mcpConfig,
      // Measured once per run, on the first attempt; later attempts reuse it.
      ...(storedBaseline ? { baselineBuild: storedBaseline } : {}),
      ...(reviewerGuidance.length > 0 ? { reviewerGuidance } : {}),
    };

    const res = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        qualifier: "DEFAULT",
        runtimeSessionId,
        contentType: "application/json",
        accept: "application/json",
        payload: Buffer.from(JSON.stringify(payload)),
      })
    );

    const bodyText = res.response
      ? Buffer.from(await res.response.transformToByteArray()).toString("utf-8")
      : "{}";

    try {
      const parsed: unknown = JSON.parse(bodyText);
      const inner =
        typeof parsed === "object" && parsed !== null && "result" in parsed
          ? (parsed as { result: unknown }).result
          : parsed;
      const agentResult = inner as ImplementResult;
      const measuredBaseline = baselineOf(agentResult.baselineBuild);
      result = {
        ...agentResult,
        buildErrors: Array.isArray(agentResult.buildErrors)
          ? agentResult.buildErrors.filter((e): e is string => typeof e === "string").slice(0, 50)
          : [],
        noNewChanges: agentResult.noNewChanges === true,
        ...(storedBaseline ?? measuredBaseline
          ? { baselineBuild: storedBaseline ?? measuredBaseline }
          : {}),
        baseCommitId,
        fixBranch,
        attempt,
        executionMode,
        kiroCredits:
          typeof agentResult.kiroCredits === "number"
            ? agentResult.kiroCredits
            : null,
        kiroCreditsStatus:
          agentResult.kiroCreditsStatus ?? "UNAVAILABLE",
        requestedRuntimeSessionId: runtimeSessionId,
        ...(res.runtimeSessionId
          ? { returnedRuntimeSessionId: res.runtimeSessionId }
          : {}),
        ...(res.traceId ? { traceId: res.traceId } : {}),
      };
    } catch {
      result = {
        ok: false,
        engine: "unknown",
        requestedModel: kiroModel,
        actualModel: "unknown",
        executionMode,
        summary: `Agent returned a non-JSON response (${bodyText.length} bytes)`,
        filesChanged: [],
        buildOk: false,
        buildOutput: "",
        fixBranch,
        baseCommitId,
        costUsd: 0,
        attempt,
        kiroCredits: null,
        kiroCreditsStatus: "UNAVAILABLE",
        requestedRuntimeSessionId: runtimeSessionId,
        ...(res.runtimeSessionId
          ? { returnedRuntimeSessionId: res.runtimeSessionId }
          : {}),
        ...(res.traceId ? { traceId: res.traceId } : {}),
        error: "invalid-agent-response",
      };
    }
  } finally {
    await releaseImplementationLease(fixBranch);
  }

  await appendEvent(
    runId,
    "IMPLEMENT",
    result.ok
      ? result.noNewChanges
        ? `No new changes: the fix from an earlier attempt is already on ${fixBranch}; it goes to validation again (build ${result.buildOk ? "PASSED" : "FAILED"})`
        : `Fix implemented via ${result.engine} in ${executionMode} mode: ${result.summary.slice(0, 200)} (build ${result.buildOk ? "PASSED" : "FAILED"})`
      : `Implementation attempt failed: ${result.error ?? result.summary}`,
    result.costUsd || 0,
    {
      engine: result.engine,
      executionMode,
      requestedModel: result.requestedModel,
      actualModel: result.actualModel,
      filesChanged: result.filesChanged,
      baseCommitId,
      fixCommitId: result.fixCommitId,
      attempt,
      kiroCredits: result.kiroCredits,
      kiroCreditsStatus: result.kiroCreditsStatus,
      cpuSeconds: result.cpuSeconds,
      peakMemoryBytes: result.peakMemoryBytes,
      agentCoreUsageStatus: result.agentCoreUsageStatus,
      agentCoreUsageSource: result.agentCoreUsageSource,
      requestedRuntimeSessionId: result.requestedRuntimeSessionId,
      returnedRuntimeSessionId: result.returnedRuntimeSessionId,
      traceId: result.traceId,
    }
  );
  await updateRun(runId, {
    implementResult: result,
    baseCommitId,
    executionMode,
    ...(result.fixCommitId ? { fixCommitId: result.fixCommitId } : {}),
    ...(!storedBaseline && result.baselineBuild ? { baselineBuild: result.baselineBuild } : {}),
  });
  if (!storedBaseline && result.baselineBuild && !result.baselineBuild.ok) {
    await appendEvent(
      runId,
      "IMPLEMENT",
      `The base commit already fails to build (${result.baselineBuild.errors.length} error line(s)); ` +
        "those errors are treated as pre-existing, and the fix must not add new ones"
    );
  }
  return result;
};
