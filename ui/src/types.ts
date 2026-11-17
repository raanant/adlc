export interface RunEvent {
  ts?: string;
  phase?: string;
  message?: string;
  costUsd?: number;
  detail?: Record<string, unknown>;
}

export interface RunLog {
  ts?: string;
  level?: "INFO" | "WARN" | "ERROR" | string;
  stage?: string;
  message?: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

export interface McpConfigResponse {
  configJson: string;
  updatedAt?: string;
  serverCount: number;
  enabledCount: number;
  maxBytes?: number;
}
/** The decision model's endpoint variants: the same model on a CPU or on a GPU instance. */
export type DeciderVariantId = "cpu" | "gpu";

/** Availability of the decider endpoint picked in Settings, for the run form. */
export interface DecisionModelStatus {
  available: boolean;
  variant: DeciderVariantId | null;
  label: string;
  instanceType: string;
  /** SageMaker EndpointStatus, or NOT_DEPLOYED / NOT_CONFIGURED / UNKNOWN. */
  status: string;
  endpointName: string;
  modelId: string;
}

/** GET/POST /decision-model/endpoint: both decider endpoints and the one the pipeline uses. */
export interface DeciderOverview {
  activeVariant: DeciderVariantId;
  activeVariantUpdatedAt: string | null;
  activeVariantUpdatedBy: string | null;
  canSelect: boolean;
  variants: DeciderEndpointStatus[];
}

/** One on-demand decider endpoint (CPU or GPU), for the Settings tab. */
export interface DeciderEndpointStatus {
  variant: DeciderVariantId;
  label: string;
  /** True for the endpoint the pipeline uses. */
  active: boolean;
  endpointName: string;
  /** NOT_DEPLOYED, UNKNOWN, or a SageMaker EndpointStatus such as Creating or InService. */
  state: string;
  serving: boolean;
  transitional: boolean;
  endpointConfigName: string;
  deployedEndpointConfigName: string | null;
  outOfDate: boolean;
  instanceType: string;
  modelId: string;
  hourlyUsd: number | null;
  creationTime: string | null;
  lastModifiedTime: string | null;
  runningHours: number | null;
  estimatedCostUsd: number | null;
  failureReason: string | null;
  canManage: boolean;
  canDeploy: boolean;
  canStop: boolean;
}

export interface ModelsResponse {
  kiroConfigured: boolean;
  models: ModelOption[];
  analysisModels: ModelOption[];
  defaultAnalysisModel: string;
  defaultTriageInstruction: string;
  decisionModel?: DecisionModelStatus;
  /** enabled is false when the stack was deployed with -c securityAgent=false. */
  securityAgent?: { enabled: boolean };
  error?: string;
}

export type ExecutionMode = "SIMPLE" | "COMPLEX";

export type TriageMode = "llm" | "both";

export interface StartRunRequest {
  bugText: string;
  kiroModel: string;
  analysisModel: string;
  triageInstruction: string;
  includeContext: boolean;
  autoExecuteSimple: boolean;
  securityMode: "skip" | "scan" | "remediate";
  triageMode: TriageMode;
  /** @deprecated Use triageMode instead. Kept for Step Function backward compatibility. */
  decisionModelEnabled: boolean;
}

export interface Draft {
  rootCause: string;
  proposedFix: string;
  filesToChange: string[];
  risks: string;
  simplePrompt: string;
  complexSpec: string;
  draftAttempt: number;
}

export interface Triage {
  complexity: "SIMPLE" | "COMPLEX";
  reasoning: string;
  estimatedFiles: number;
  bugId: string;
  title: string;
  recommendedModel?: string;
  alternativeModel?: string;
  modelReasoning?: string;
}

/**
 * The decision model's informative second opinion on triage. It is recorded and displayed only;
 * routing always follows the LLM triage verdict.
 */
export interface DecisionModelResult {
  status: "RUNNING" | "COMPLETED" | "FAILED" | "UNAVAILABLE";
  provider?: string;
  /** The endpoint variant the run used (picked in Settings); absent on older runs (CPU). */
  variant?: DeciderVariantId | null;
  variantLabel?: string | null;
  instanceType?: string | null;
  endpointName?: string;
  advisoryOnly?: boolean;
  llmVerdict?: ExecutionMode | null;
  verdict?: ExecutionMode;
  /** How likely the verdict is (0.5 to 1): the weakest pass, or the strongest failing check. */
  probability?: number;
  certainty?: "HIGH" | "MEDIUM" | "LOW";
  checks?: Array<{
    id: string;
    label: string;
    /** Probability the model gives to "true". */
    pTrue: number;
    /** Probability that this check keeps the fix SIMPLE. */
    pSimple: number;
    passes: boolean;
    text: string;
  }>;
  /** The check that decided the verdict. */
  decidingCheck?: string;
  /** The exact prompt text the model read, and the request body sent to the endpoint. */
  prompt?: {
    stateBlock: string;
    questions: Array<{ id: string; label: string; block: string }>;
    request: unknown;
  };
  /** Legacy (runs before the five checks): probabilities of one broad SIMPLE/COMPLEX question. */
  probabilities?: Record<ExecutionMode, number>;
  /** Legacy: |P(SIMPLE) - P(COMPLEX)|. */
  confidence?: number;
  /** Legacy. */
  confidenceBand?: "HIGH" | "MEDIUM" | "LOW";
  agreesWithLlm?: boolean | null;
  modelId?: string;
  inputTokens?: number | null;
  serverLatencyMs?: number | null;
  roundTripMs?: number;
  input?: { stateChars: number; bugReportChars: number; bugReportTruncated: boolean };
  error?: { code: string; message: string };
  startedAt?: string;
  completedAt?: string;
}

export type BuildVerdict = "PASSED" | "PRE_EXISTING_ONLY" | "NEW_ERRORS" | "FAILED_UNCOMPARABLE";

export interface BuildGate {
  verdict: BuildVerdict;
  ok: boolean;
  newErrors: string[];
  preExistingErrors: string[];
  fixedErrors: string[];
  baselineOk: boolean | null;
}

export interface Validation {
  pass: boolean;
  checks: Array<{ requirement: string; pass: boolean; note: string }>;
  issues: string[];
  fixAttempts: number;
  /** False when another automatic attempt could not change the outcome. */
  retryable?: boolean;
  stopReason?: string;
  buildGate?: BuildGate;
  noChanges?: boolean;
  modelReviewed?: boolean;
}

/** The review gate while a run waits for a person (status AWAITING_REVIEW). */
export interface ReviewState {
  round: number;
  openedAt: string;
  expiresAt: string;
  reason: string;
  attemptsUsed: number;
  attemptBudget: number;
  canRetry: boolean;
  retryUnavailableReason?: string;
  maxAdditionalAttempts: number;
}

export type ReviewAction = "accept" | "retry" | "close";

export interface ReviewDecisionRecord {
  round: number;
  action: ReviewAction;
  reason?: string;
  guidance?: string;
  additionalAttempts?: number;
  attemptBudget?: number;
  artifactVersion?: number;
  artifactEdited?: boolean;
  reviewer: string;
  decidedAt: string;
  failedChecks: string[];
  attemptsAtDecision: number;
}

export type UsageStatus =
  | "COMPLETE"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "NOT_APPLICABLE";

export interface UsageBreakdown {
  analysis: {
    status: UsageStatus;
    modelId: string | null;
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    costUsd: number | null;
  };
  kiro: {
    status: UsageStatus;
    attempts: number;
    credits: number | null;
    costUsd: number | null;
  };
  agentCore: {
    status: UsageStatus;
    attempts: number;
    cpuSeconds: number | null;
    peakMemoryBytes: number | null;
    peakMemoryMiB: number | null;
    source: "cgroup-v2 usage log";
    sessions: Array<{
      attempt: number;
      runtimeSessionId: string | null;
      requestedRuntimeSessionId: string | null;
      returnedRuntimeSessionId: string | null;
      traceId: string | null;
      cpuSeconds: number | null;
      peakMemoryBytes: number | null;
      startTimestamp: string | null;
      endTimestamp: string | null;
      status: UsageStatus;
    }>;
  };
  security?: {
    status: UsageStatus;
    taskHours: number | null;
    costUsd: number | null;
    mode: string;
  };
}

export interface Report {
  headline: string;
  totalTimeSeconds: number;
  totalCostUsd: number;
  tasksCompleted: number;
  fixLoops: number;
  draftAttempts: number;
  fixBranch?: string | null;
  engine?: string | null;
  requestedModel?: string | null;
  actualModel?: string | null;
  executionMode?: ExecutionMode | null;
  analysisModel?: string | null;
  usageBreakdown?: UsageBreakdown;
  failure?: {
    stage?: string;
    code?: string;
    message?: string;
    retryable?: boolean;
  };
  review?: {
    outcome: "ACCEPTED" | "CLOSED" | "TIMED_OUT" | "RETRIED";
    rounds: number;
    decidedBy: string | null;
    reason: string | null;
    failedChecks: string[];
    validationPassed: boolean;
  };
}

export interface Run {
  runId?: string;
  status?: string;
  bugText?: string;
  kiroModel?: string;
  analysisModel?: string;
  triageInstruction?: string;
  includeContext?: boolean;
  autoExecuteSimple?: boolean;
  securityMode?: string;
  decisionModelEnabled?: boolean;
  decisionModel?: DecisionModelResult;
  workflowVersion?: number;
  contextAudit?: {
    enabled: boolean;
    itemIds?: string[];
    digests?: string[];
    count: number;
    totalBytes: number;
  };
  selectedMode?: ExecutionMode;
  selectedArtifact?: string;
  createdAt?: string;
  updatedAt?: string;
  costUsd?: number;
  startedBy?: string;
  events?: RunEvent[];
  logs?: RunLog[];
  logCount?: number;
  triage?: Triage;
  draft?: Draft;
  validation?: Validation;
  report?: Report;
  approval?: {
    action?: "execute" | "cancel";
    approved: boolean;
    selectedMode?: ExecutionMode;
    selectedArtifact?: string;
    feedback?: string;
    reviewer?: string;
  };
  implementResult?: {
    engine?: string;
    requestedModel?: string;
    actualModel?: string;
    executionMode?: ExecutionMode;
    summary?: string;
    buildOk?: boolean;
    buildOutput?: string;
    filesChanged?: string[];
    attempt?: number;
    kiroCredits?: number | null;
    kiroCreditsStatus?: UsageStatus;
    requestedRuntimeSessionId?: string;
    returnedRuntimeSessionId?: string;
    traceId?: string;
    cpuSeconds?: number | null;
    peakMemoryBytes?: number | null;
    agentCoreUsageStatus?: UsageStatus;
    agentCoreUsageSource?: string;
    error?: string;
    noNewChanges?: boolean;
    buildErrors?: string[];
  };
  fixBranch?: string;
  fixCommitId?: string;
  baseCommitId?: string;
  approvedArtifact?: string;
  fixAttempts?: number;
  /** Implementation attempts allowed before the next review (3, raised by a retry decision). */
  attemptBudget?: number;
  review?: ReviewState;
  reviewDecisions?: ReviewDecisionRecord[];
  reviewOutcome?: "accepted" | "closed";
  artifactVersions?: Array<{ version: number; artifact: string; createdBy: string; createdAt: string; source: string }>;
  baselineBuild?: { ok: boolean; errors: string[]; commitId?: string };
  securityReview?: SecurityReview;
  securityDecision?: {
    action: "accept" | "remediate";
    feedback?: string;
    reviewer?: string;
    decidedAt?: string;
  };
}

export interface SecurityReview {
  reviewed: boolean;
  findingsCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findings: Array<{
    name: string;
    riskLevel: string;
    confidence: string;
    status: string;
    findingId: string;
    remediation?: string;
    description?: string;
  }>;
  codeReviewId?: string;
  codeReviewJobId?: string;
  pentestId?: string;
  pentestJobId?: string;
  passed: boolean;
  phase?: string;
  status?: string;
  pentestTaskHours?: number;
  pentestCostUsd?: number;
}

export interface AppConfig {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
}

export interface RepositoryRef {
  kind: "base" | "fix";
  name: string;
  commitId: string;
  implementationCommitId?: string;
  label: string;
  runId?: string;
  status?: string;
  validationPass?: boolean;
  completedAt?: string;
}

export interface BugTarget {
  id: string;
  title: string;
  path: string;
  lineStart: number;
  lineEnd: number;
  description: string;
}

export interface RepositoryRefsResponse {
  repositoryName: string;
  refs: RepositoryRef[];
  bugTargets: BugTarget[];
  canDeleteFixBranches: boolean;
}

export interface RepositoryTreeEntry {
  name: string;
  path: string;
  type: "file" | "folder";
  size?: number;
  blobId?: string;
}

export interface RepositoryTreeResponse {
  ref: string;
  commitId: string;
  path: string;
  entries: RepositoryTreeEntry[];
}

export interface RepositoryFile {
  ref?: string;
  commitId?: string;
  baseCommitId?: string;
  fixCommitId?: string;
  path?: string;
  content?: string;
  size?: number;
  blobId?: string;
}

export interface ReviewFile {
  path: string;
  changeType: "A" | "D" | "M";
  before: RepositoryFile | null;
  after: RepositoryFile | null;
}

export interface RunReview {
  runId?: string;
  status?: string;
  base?: { branch?: string; commitId?: string };
  fix?: { branch?: string; commitId?: string };
  files?: ReviewFile[];
  evidence?: {
    implementation?: {
      engine?: string;
      requestedModel?: string;
      actualModel?: string;
      summary?: string;
      filesChanged: string[];
      buildOk: boolean;
      buildOutput: string;
      buildCommand: string;
      attempt?: number;
    };
    validation: Validation | null;
    report: Report | null;
    triage: Triage | null;
    draft: Draft | null;
  };
}

export interface ResetStatus {
  repositoryName: string;
  branch: string;
  mainHeadCommitId: string;
  canonicalCommitId: string;
  seedDigest: string;
  alreadyCanonical: boolean;
  activeRuns: Array<{ runId: string; status: string }>;
  canReset: boolean;
  resetAllowed: boolean;
  requiredConfirmation: string;
}

export type ContextContentType =
  | "text/plain"
  | "application/pdf"
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface ContextItem {
  itemId: string;
  kind: "note" | "file" | "image";
  fileName: string;
  contentType: ContextContentType;
  sizeBytes: number;
  digest?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContextListResponse {
  items: ContextItem[];
  quota: {
    itemCount: number;
    totalBytes: number;
    maxItems: number;
    maxTotalBytes: number;
  };
}

export interface ContextUploadReservation {
  itemId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: { "Content-Type": ContextContentType };
}

export interface ContextPreview {
  url: string;
  expiresInSeconds: number;
  item: ContextItem;
}
