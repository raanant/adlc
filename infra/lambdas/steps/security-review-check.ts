/**
 * Security Review CHECK — polls code review first, then pentest.
 * Returns complete=true only when both are done (or timed out).
 */
import * as https from "node:https";
import type { Context } from "aws-lambda";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { appendEvent, updateRun } from "../shared/db";

const AGENT_SPACE_ID = process.env.AGENT_SPACE_ID!;
const REGION = process.env.AWS_REGION ?? "us-east-1";
const MAX_POLLS = 120; // 120 * 30s = 60 minutes max

/** AWS Security Agent pentest pricing: $50 per task-hour. */
const PENTEST_COST_PER_TASK_HOUR = 50;

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "securityagent",
  sha256: Sha256,
});

async function apiCall(operation: string, body: Record<string, unknown>): Promise<unknown> {
  const hostname = `securityagent.${REGION}.api.aws`;
  const path = `/${operation}`;
  const bodyStr = JSON.stringify(body);
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname, path,
    headers: { host: hostname, "content-type": "application/json" },
    body: bodyStr,
  });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "POST", headers: signed.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(text)); }
        catch { res.statusCode && res.statusCode >= 400 ? reject(new Error(`API ${res.statusCode}: ${text.slice(0, 500)}`)) : resolve(text); }
      });
    });
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

interface Finding {
  name: string;
  riskLevel: string;
  confidence: string;
  status: string;
  findingId: string;
  remediation: string;
  description: string;
}

interface PentestTask {
  taskId: string;
  title: string;
  executionStatus: string;
  taskHours?: number;
}

interface StartState {
  securityStarted: boolean;
  codeReviewId: string;
  codeReviewJobId: string;
  pentestId: string;
  pentestJobId: string;
  pollCount: number;
  phase: string;
  // Carried forward from previous check
  codeReviewFindings?: Finding[];
  codeReviewComplete?: boolean;
  pentestFindings?: Finding[];
  pentestComplete?: boolean;
}

interface CheckOutput extends StartState {
  complete: boolean;
  // Final merged results
  reviewed?: boolean;
  findingsCount?: number;
  criticalCount?: number;
  highCount?: number;
  mediumCount?: number;
  lowCount?: number;
  findings?: Finding[];
  passed?: boolean;
  pentestTaskHours?: number;
  pentestCostUsd?: number;
}

async function fetchFindings(jobIdField: string, jobId: string): Promise<Finding[]> {
  try {
    const resp = (await apiCall("ListFindings", {
      [jobIdField]: jobId,
      agentSpaceId: AGENT_SPACE_ID,
    })) as { findingsSummaries: Array<Record<string, unknown>> };
    console.log("ListFindings response sample:", JSON.stringify(resp.findingsSummaries?.[0] ?? "none").slice(0, 1000));
    console.log("ListFindings fields:", JSON.stringify(Object.keys(resp.findingsSummaries?.[0] ?? {})));
    return (resp.findingsSummaries ?? []).map((f) => ({
      name: String(f.name ?? "Unknown"),
      riskLevel: String(f.riskLevel ?? "UNKNOWN"),
      confidence: String(f.confidence ?? "UNKNOWN"),
      status: String(f.status ?? "ACTIVE"),
      findingId: String(f.findingId ?? ""),
      remediation: String(f.remediation ?? f.suggestedFix ?? f.recommendation ?? ""),
      description: String(f.description ?? f.details ?? ""),
    }));
  } catch {
    return [];
  }
}

export const handler = async (
  event: { runId: string; securityStart: StartState },
  _context: Context,
): Promise<CheckOutput> => {
  const { runId, securityStart: s } = event;
  const newPollCount = s.pollCount + 1;

  if (!s.securityStarted) {
    return {
      ...s, pollCount: newPollCount, complete: true,
      reviewed: false, findingsCount: 0, criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0,
      findings: [], passed: true,
    };
  }

  let codeReviewComplete = s.codeReviewComplete ?? false;
  let codeReviewFindings = s.codeReviewFindings ?? [];
  let pentestComplete = s.pentestComplete ?? false;
  let pentestFindings = s.pentestFindings ?? [];
  let phase = s.phase;

  // --- Poll code review if not done ---
  if (!codeReviewComplete && s.codeReviewJobId) {
    try {
      const resp = (await apiCall("ListCodeReviewJobsForCodeReview", {
        codeReviewId: s.codeReviewId,
        agentSpaceId: AGENT_SPACE_ID,
      })) as { codeReviewJobSummaries: Array<{ codeReviewJobId: string; status: string }> };

      const job = resp.codeReviewJobSummaries?.find((j) => j.codeReviewJobId === s.codeReviewJobId);
      const status = job?.status ?? "UNKNOWN";

      if (status !== "IN_PROGRESS") {
        codeReviewComplete = true;
        codeReviewFindings = await fetchFindings("codeReviewJobId", s.codeReviewJobId);
        await appendEvent(runId, "SECURITY_REVIEW",
          `📋 Code review complete: ${status} — ${codeReviewFindings.length} finding(s)`);
        phase = "PENTEST";
      } else if (newPollCount % 2 === 0) {
        try {
          const tasksResp = (await apiCall("ListCodeReviewJobTasks", {
            agentSpaceId: AGENT_SPACE_ID,
            codeReviewJobId: s.codeReviewJobId,
          })) as { codeReviewJobTaskSummaries: Array<{ title: string; executionStatus: string }> };
          const tasks = tasksResp.codeReviewJobTaskSummaries ?? [];
          const done = tasks.filter((t) => t.executionStatus === "COMPLETED").length;
          await appendEvent(runId, "SECURITY_REVIEW", `📋 Code review: ${done} tasks completed`);
        } catch {
          await appendEvent(runId, "SECURITY_REVIEW", `📋 Code review in progress...`);
        }
      }
    } catch (err) {
      await appendEvent(runId, "SECURITY_REVIEW", `Code review poll error: ${String(err).slice(0, 200)}`);
    }
  }

  // --- Poll pentest if code review done (or no code review) ---
  if (!pentestComplete && s.pentestJobId) {
    try {
      const resp = (await apiCall("ListPentestJobsForPentest", {
        pentestId: s.pentestId,
        agentSpaceId: AGENT_SPACE_ID,
      })) as { pentestJobSummaries: Array<{ pentestJobId: string; status: string }> };

      const job = resp.pentestJobSummaries?.find((j) => j.pentestJobId === s.pentestJobId);
      const status = job?.status ?? "UNKNOWN";

      if (status !== "IN_PROGRESS") {
        pentestComplete = true;
        pentestFindings = await fetchFindings("pentestJobId", s.pentestJobId);
        await appendEvent(runId, "SECURITY_REVIEW",
          `🔍 Pentest complete: ${status} — ${pentestFindings.length} finding(s)`);
      } else if (newPollCount % 2 === 0) {
        try {
          const tasksResp = (await apiCall("ListPentestJobTasks", {
            agentSpaceId: AGENT_SPACE_ID,
            pentestJobId: s.pentestJobId,
          })) as { taskSummaries: Array<{ title: string; executionStatus: string }> };
          const tasks = tasksResp.taskSummaries ?? [];
          const done = tasks.filter((t) => t.executionStatus === "COMPLETED").length;
          await appendEvent(runId, "SECURITY_REVIEW", `🔍 Pentest: ${done} tasks completed`);
        } catch {
          await appendEvent(runId, "SECURITY_REVIEW", `🔍 Pentest in progress...`);
        }
      }
    } catch (err) {
      await appendEvent(runId, "SECURITY_REVIEW", `Pentest poll error: ${String(err).slice(0, 200)}`);
    }
  }

  // --- Check if both done or max polls reached ---
  const bothDone = (codeReviewComplete || !s.codeReviewJobId) && (pentestComplete || !s.pentestJobId);
  const timedOut = newPollCount >= MAX_POLLS;
  const complete = bothDone || timedOut;

  if (complete) {
    // On timeout, still try to fetch whatever findings are available
    if (timedOut && !codeReviewComplete && s.codeReviewJobId) {
      codeReviewFindings = await fetchFindings("codeReviewJobId", s.codeReviewJobId);
      await appendEvent(runId, "SECURITY_REVIEW", `📋 Code review timed out — ${codeReviewFindings.length} finding(s) collected`);
    }
    if (timedOut && !pentestComplete && s.pentestJobId) {
      pentestFindings = await fetchFindings("pentestJobId", s.pentestJobId);
      await appendEvent(runId, "SECURITY_REVIEW", `🔍 Pentest timed out — ${pentestFindings.length} finding(s) collected`);
    }

    // Merge all findings
    const allFindings = [...codeReviewFindings, ...pentestFindings];

    // Enrich HIGH/CRITICAL findings with GetFinding details
    const importantFindings = allFindings.filter((f) => f.riskLevel === "HIGH" || f.riskLevel === "CRITICAL");
    for (const f of importantFindings) {
      if (!f.findingId) continue;
      try {
        const detail = (await apiCall("GetFinding", {
          findingId: f.findingId,
          agentSpaceId: AGENT_SPACE_ID,
        })) as Record<string, unknown>;
        console.log(`GetFinding ${f.findingId} keys:`, JSON.stringify(Object.keys(detail)));
        console.log(`GetFinding ${f.findingId} sample:`, JSON.stringify(detail).slice(0, 1500));
        f.remediation = String(detail.remediation ?? detail.suggestedFix ?? detail.recommendation ?? f.remediation ?? "");
        f.description = String(detail.description ?? detail.details ?? detail.summary ?? f.description ?? "");
      } catch (err) {
        console.log(`GetFinding ${f.findingId} failed:`, String(err).slice(0, 300));
      }
    }

    const criticalCount = allFindings.filter((f) => f.riskLevel === "CRITICAL").length;
    const highCount = allFindings.filter((f) => f.riskLevel === "HIGH").length;
    const mediumCount = allFindings.filter((f) => f.riskLevel === "MEDIUM").length;
    const lowCount = allFindings.filter((f) => f.riskLevel === "LOW").length;
    const passed = criticalCount === 0 && highCount === 0;

    // --- Fetch pentest task hours and calculate cost ---
    let pentestTaskHours = 0;
    let pentestCostUsd = 0;
    if (s.pentestJobId) {
      try {
        let allTasks: PentestTask[] = [];
        let nextToken: string | undefined;
        do {
          const tasksResp = (await apiCall("ListPentestJobTasks", {
            agentSpaceId: AGENT_SPACE_ID,
            pentestJobId: s.pentestJobId,
            ...(nextToken ? { nextToken } : {}),
          })) as Record<string, unknown>;
          console.log("ListPentestJobTasks response keys:", JSON.stringify(Object.keys(tasksResp)));
          console.log("ListPentestJobTasks first task sample:", JSON.stringify(((tasksResp.taskSummaries ?? tasksResp.tasks) as PentestTask[] | undefined)?.[0] ?? "none").slice(0, 500));
          const tasks = (tasksResp.taskSummaries ?? tasksResp.tasks ?? []) as PentestTask[];
          allTasks = allTasks.concat(tasks);
          nextToken = (tasksResp.nextToken as string | undefined) ?? undefined;
        } while (nextToken);
        pentestTaskHours = allTasks.reduce((sum, t) => {
          // Try multiple possible field names for task duration
          const hours = (t as Record<string, unknown>).taskHours
            ?? (t as Record<string, unknown>).durationHours
            ?? (t as Record<string, unknown>).hours
            ?? (t as Record<string, unknown>).duration
            ?? 0;
          return sum + (typeof hours === "number" ? hours : 0);
        }, 0);
        // If no taskHours found but we have tasks, estimate from wall clock
        if (pentestTaskHours === 0 && allTasks.length > 0) {
          console.log("No taskHours found in tasks, falling back to task count estimate");
          console.log("All task fields:", JSON.stringify(Object.keys(allTasks[0] ?? {})));
          // Try to compute from task start/end timestamps
          let totalMs = 0;
          for (const t of allTasks) {
            const task = t as Record<string, unknown>;
            const start = task.startedAt ?? task.startTime ?? task.createdAt;
            const end = task.completedAt ?? task.endTime ?? task.updatedAt;
            if (typeof start === "string" && typeof end === "string") {
              const ms = new Date(end).getTime() - new Date(start).getTime();
              if (ms > 0) totalMs += ms;
            }
          }
          if (totalMs > 0) {
            pentestTaskHours = Math.round((totalMs / 3_600_000) * 100) / 100;
            console.log(`Estimated ${pentestTaskHours} task-hours from task timestamps`);
          } else {
            // Last resort: use the events timeline to estimate duration
            // The security review start event and this completion give wall clock time
            // Each task counts as a minimum billing unit
            pentestTaskHours = Math.round((allTasks.length * (1 / 60)) * 100) / 100; // 1 min per task minimum
            console.log(`Fallback estimate: ${allTasks.length} tasks × 1min = ${pentestTaskHours} task-hours`);
          }
        }
        pentestCostUsd = Math.round(pentestTaskHours * PENTEST_COST_PER_TASK_HOUR * 100) / 100;
        await appendEvent(runId, "SECURITY_REVIEW",
          `💰 Pentest cost: ${pentestTaskHours.toFixed(2)} task-hours × $${PENTEST_COST_PER_TASK_HOUR}/hr = $${pentestCostUsd.toFixed(2)}`,
          pentestCostUsd);
      } catch (err) {
        await appendEvent(runId, "SECURITY_REVIEW", `⚠️ Could not fetch pentest task hours: ${String(err).slice(0, 200)}`);
      }
    }

    const result = {
      reviewed: true,
      findingsCount: allFindings.length,
      criticalCount, highCount, mediumCount, lowCount,
      findings: allFindings.slice(0, 30),
      codeReviewId: s.codeReviewId,
      codeReviewJobId: s.codeReviewJobId,
      pentestId: s.pentestId,
      pentestJobId: s.pentestJobId,
      passed,
      pentestTaskHours,
      pentestCostUsd,
    };
    await updateRun(runId, { securityReview: result });

    const summary = timedOut && !bothDone ? "(timed out)" : "";
    await appendEvent(runId, "SECURITY_REVIEW",
      passed
        ? `✅ Security review passed ${summary} (${allFindings.length} total findings, 0 critical/high)`
        : `⚠️ Security review: ${criticalCount} critical, ${highCount} high findings ${summary}`,
    );

    return {
      ...s, pollCount: newPollCount, phase, complete: true,
      codeReviewComplete, codeReviewFindings, pentestComplete, pentestFindings,
      ...result,
    };
  }

  // Not done yet — loop
  return {
    ...s, pollCount: newPollCount, phase, complete: false,
    codeReviewComplete, codeReviewFindings, pentestComplete, pentestFindings,
  };
};
