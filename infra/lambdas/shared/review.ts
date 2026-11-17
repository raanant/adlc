/**
 * The review gate: where a run waits for a human when automatic fix attempts cannot finish it
 * (the attempt budget is used up, or another attempt could not change the outcome).
 *
 * The reviewer can accept the fix without a green validation (with a reason), retry with
 * guidance (optionally editing the approved artifact, granting 1–3 more attempts), or close the
 * run. Any signed-in user may decide; every decision is recorded on the run.
 */

/** Automatic attempts a run gets before the first review. */
export const INITIAL_ATTEMPT_BUDGET = 3;
/** Attempts one "retry with guidance" decision may grant. */
export const MAX_ADDITIONAL_ATTEMPTS = 3;
/** Hard ceiling on implementation attempts per run, across all reviews. */
export const MAX_TOTAL_ATTEMPTS = 9;
/** Review rounds per run; at the last one only Accept and Close are offered. */
export const MAX_REVIEW_ROUNDS = 3;
/** How long the review gate waits before the run closes on its own. */
export const REVIEW_TIMEOUT_DAYS = 7;

export const MIN_REASON_CHARS = 10;
export const MAX_REASON_CHARS = 2_000;
export const MAX_GUIDANCE_CHARS = 4_000;

export type ReviewAction = "accept" | "retry" | "close";

/** One decision at the review gate, as stored on the run (`reviewDecisions`). */
export interface ReviewDecisionRecord {
  round: number;
  action: ReviewAction;
  /** Accept: why the fix is acceptable. Close: optional note. */
  reason?: string;
  /** Retry: instructions added to Kiro's prompt for the next attempts. */
  guidance?: string;
  additionalAttempts?: number;
  attemptBudget?: number;
  /** Retry: version number of the approved artifact the next attempts use. */
  artifactVersion?: number;
  artifactEdited?: boolean;
  reviewer: string;
  reviewerSub: string;
  decidedAt: string;
  /** Validation state the reviewer decided on. */
  failedChecks: string[];
  attemptsAtDecision: number;
}

/** What the review gate shows and allows, stored on the run (`review`) while it waits. */
export interface ReviewState {
  round: number;
  openedAt: string;
  expiresAt: string;
  /** Why the run stopped for review. */
  reason: string;
  attemptsUsed: number;
  attemptBudget: number;
  canRetry: boolean;
  /** Why Retry is not offered, when canRetry is false. */
  retryUnavailableReason?: string;
  maxAdditionalAttempts: number;
}

export function retryAllowance(
  round: number,
  attemptsUsed: number
): { canRetry: boolean; maxAdditionalAttempts: number; reason?: string } {
  if (round >= MAX_REVIEW_ROUNDS) {
    return {
      canRetry: false,
      maxAdditionalAttempts: 0,
      reason: `This is review ${round} of ${MAX_REVIEW_ROUNDS}; only Accept and Close are offered now.`,
    };
  }
  const left = MAX_TOTAL_ATTEMPTS - attemptsUsed;
  if (left <= 0) {
    return {
      canRetry: false,
      maxAdditionalAttempts: 0,
      reason: `The run has used the maximum of ${MAX_TOTAL_ATTEMPTS} implementation attempts.`,
    };
  }
  return { canRetry: true, maxAdditionalAttempts: Math.min(MAX_ADDITIONAL_ATTEMPTS, left) };
}
