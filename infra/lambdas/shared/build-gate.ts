/**
 * Build gate: compare the fix branch's build with the build of the commit the run started from.
 *
 * The coding agent builds the base commit once per run, before Kiro edits anything, and reports
 * the error lines of both builds (agent/app.py `build_error_lines`: TypeScript `error TSxxxx` lines
 * with the line and column removed, so an error that moved because of an edit still matches).
 *
 * A fix passes the gate when its build succeeds, or when the base commit already failed and the
 * fix adds no error that the base did not have. Errors that only the fix branch has are "new".
 */

export interface BuildSnapshot {
  ok: boolean;
  /** Normalized error lines; empty when the build passed or no error line could be parsed. */
  errors: string[];
}

export type BuildVerdict =
  /** The fix branch builds. */
  | "PASSED"
  /** The fix branch fails only with errors that already fail the base commit. */
  | "PRE_EXISTING_ONLY"
  /** The fix branch has build errors the base commit does not have. */
  | "NEW_ERRORS"
  /** The build failed and its errors could not be compared with the base build. */
  | "FAILED_UNCOMPARABLE";

export interface BuildGate {
  verdict: BuildVerdict;
  /** True for PASSED and PRE_EXISTING_ONLY. */
  ok: boolean;
  newErrors: string[];
  preExistingErrors: string[];
  /** Base-commit errors the fix branch no longer has. */
  fixedErrors: string[];
  baselineOk: boolean | null;
  /** Stable text of the new errors, to tell whether a retry changed anything. */
  signature: string;
}

const MAX_ERRORS = 50;
const MAX_ERROR_CHARS = 300;

/** Defensive parse of a snapshot that came back from the agent. */
export function buildSnapshot(ok: unknown, errors: unknown): BuildSnapshot {
  const list = Array.isArray(errors)
    ? errors
        .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
        .map((e) => e.trim().slice(0, MAX_ERROR_CHARS))
        .slice(0, MAX_ERRORS)
    : [];
  return { ok: ok === true, errors: [...new Set(list)] };
}

export function compareBuilds(after: BuildSnapshot, baseline: BuildSnapshot | null): BuildGate {
  const baselineErrors = new Set(baseline && !baseline.ok ? baseline.errors : []);
  const baselineOk = baseline ? baseline.ok : null;
  if (after.ok) {
    return {
      verdict: "PASSED",
      ok: true,
      newErrors: [],
      preExistingErrors: [],
      fixedErrors: [...baselineErrors].sort(),
      baselineOk,
      signature: "",
    };
  }
  const afterErrors = new Set(after.errors);
  const fixedErrors = [...baselineErrors].filter((e) => !afterErrors.has(e)).sort();
  if (after.errors.length === 0) {
    return {
      verdict: "FAILED_UNCOMPARABLE",
      ok: false,
      newErrors: [],
      preExistingErrors: [],
      fixedErrors,
      baselineOk,
      signature: "uncomparable",
    };
  }
  const newErrors = after.errors.filter((e) => !baselineErrors.has(e)).sort();
  const preExistingErrors = after.errors.filter((e) => baselineErrors.has(e)).sort();
  if (newErrors.length === 0) {
    return {
      verdict: "PRE_EXISTING_ONLY",
      ok: true,
      newErrors,
      preExistingErrors,
      fixedErrors,
      baselineOk,
      signature: "",
    };
  }
  return {
    verdict: "NEW_ERRORS",
    ok: false,
    newErrors,
    preExistingErrors,
    fixedErrors,
    baselineOk,
    signature: newErrors.join("\n"),
  };
}

/** One sentence for events, checks and the validator prompt. */
export function describeBuildGate(gate: BuildGate): string {
  const list = (errors: string[]) =>
    errors
      .slice(0, 5)
      .map((e) => e.replace(/\.+$/, ""))
      .join("; ") + (errors.length > 5 ? `; and ${errors.length - 5} more` : "");
  switch (gate.verdict) {
    case "PASSED":
      return gate.fixedErrors.length > 0
        ? `The build passes; it also no longer has ${gate.fixedErrors.length} error(s) that failed the base commit.`
        : "The build passes.";
    case "PRE_EXISTING_ONLY":
      return (
        `The build still fails, but only with ${gate.preExistingErrors.length} error(s) that already fail the ` +
        `base commit (pre-existing, out of scope): ${list(gate.preExistingErrors)}. The fix adds no build error.`
      );
    case "NEW_ERRORS":
      return (
        `The fix adds ${gate.newErrors.length} build error(s) that the base commit does not have: ${list(gate.newErrors)}` +
        (gate.preExistingErrors.length > 0
          ? `. ${gate.preExistingErrors.length} other error(s) are pre-existing.`
          : ".")
      );
    case "FAILED_UNCOMPARABLE":
      return "The build failed and its errors could not be compared with the base commit's build.";
  }
}
