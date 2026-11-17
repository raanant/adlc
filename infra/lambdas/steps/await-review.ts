import { appendEvent, getRun, updateRun } from "../shared/db";
import {
  INITIAL_ATTEMPT_BUDGET,
  REVIEW_TIMEOUT_DAYS,
  type ReviewState,
  retryAllowance,
} from "../shared/review";

/**
 * Pause the run for a human review decision (accept / retry with guidance / close). Called with
 * a task token when automatic attempts cannot finish the run; POST /runs/{runId}/review-decision
 * resumes it. The state times out after REVIEW_TIMEOUT_DAYS and the run is then closed.
 */
export const handler = async (event: {
  runId: string;
  taskToken: string;
  validation?: { fixAttempts?: unknown; retryable?: unknown; stopReason?: unknown };
  budget?: { attemptBudget?: unknown };
}): Promise<void> => {
  const { runId, taskToken } = event;
  const run = await getRun(runId);
  const decisions = Array.isArray(run?.reviewDecisions) ? run.reviewDecisions : [];
  const round = decisions.length + 1;
  const attemptsUsed = Number(event.validation?.fixAttempts ?? run?.fixAttempts ?? 0) || 0;
  const attemptBudget = Number(event.budget?.attemptBudget ?? INITIAL_ATTEMPT_BUDGET) || INITIAL_ATTEMPT_BUDGET;
  const reason =
    typeof event.validation?.stopReason === "string" && event.validation.stopReason
      ? `Automatic retries stopped: ${event.validation.stopReason}`
      : `All ${attemptBudget} implementation attempts were used without a green validation.`;
  const allowance = retryAllowance(round, attemptsUsed);
  const openedAt = new Date();
  const review: ReviewState = {
    round,
    openedAt: openedAt.toISOString(),
    expiresAt: new Date(openedAt.getTime() + REVIEW_TIMEOUT_DAYS * 86_400_000).toISOString(),
    reason,
    attemptsUsed,
    attemptBudget,
    canRetry: allowance.canRetry,
    ...(allowance.reason ? { retryUnavailableReason: allowance.reason } : {}),
    maxAdditionalAttempts: allowance.maxAdditionalAttempts,
  };
  await updateRun(runId, { status: "AWAITING_REVIEW", taskToken, review, attemptBudget });
  await appendEvent(
    runId,
    "REVIEW",
    `Review needed (${round}): ${reason} Accept the fix with a reason, ` +
      `${allowance.canRetry ? "retry with guidance, " : ""}or close the run. ` +
      `Closes on its own on ${review.expiresAt.slice(0, 10)} if nobody decides.`
  );
};
