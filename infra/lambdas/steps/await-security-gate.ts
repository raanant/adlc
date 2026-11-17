import { appendEvent, updateRun } from "../shared/db";

/** Store the callback token and pause for a human security remediation decision. */
export const handler = async (event: {
  runId: string;
  taskToken: string;
  securityStart: {
    findingsCount?: number;
    criticalCount?: number;
    highCount?: number;
    mediumCount?: number;
    lowCount?: number;
    passed?: boolean;
  };
}): Promise<void> => {
  const { runId, taskToken, securityStart } = event;
  const { criticalCount = 0, highCount = 0, mediumCount = 0, lowCount = 0, findingsCount = 0 } = securityStart ?? {};

  await updateRun(runId, { status: "AWAITING_SECURITY_GATE", taskToken });
  await appendEvent(
    runId,
    "SECURITY_GATE",
    `🛡️ Security gate: ${findingsCount} findings (${criticalCount} critical, ${highCount} high, ${mediumCount} medium, ${lowCount} low). Review findings and choose: Accept risks or Remediate.`
  );
};
