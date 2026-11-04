/**
 * Evaluate the decision model on the hand-labelled cases in cases.json, using the production
 * request, parsing and verdict code (infra/lambdas/shared/decider.ts).
 *
 *   Local server:     DECIDER_URL=http://127.0.0.1:8099/invocations npx tsx evaluate.ts
 *   SageMaker:        DECIDER_ENDPOINT=adlc-poc-decider npx tsx evaluate.ts   (AWS credentials)
 *
 * Run from decider/eval after `npm ci` in infra (the SageMaker client is resolved from there) and
 * in decider/model-fetch (for tsx).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  buildDeciderRequest,
  buildDeciderState,
  parseDeciderResponse,
} from "../../infra/lambdas/shared/decider";

interface Case {
  id: string;
  gold: "SIMPLE" | "COMPLEX";
  text: string;
}

const cases = (JSON.parse(readFileSync(path.join(__dirname, "cases.json"), "utf8")) as { cases: Case[] }).cases;

async function ask(body: string): Promise<unknown> {
  const endpoint = process.env.DECIDER_ENDPOINT;
  if (endpoint) {
    // The SDK is an infra dependency; resolve it from there.
    const infraRequire = createRequire(path.join(__dirname, "../../infra/package.json"));
    const { SageMakerRuntimeClient, InvokeEndpointCommand } = infraRequire(
      "@aws-sdk/client-sagemaker-runtime"
    ) as typeof import("@aws-sdk/client-sagemaker-runtime");
    const client = new SageMakerRuntimeClient({});
    const res = await client.send(
      new InvokeEndpointCommand({
        EndpointName: endpoint,
        ContentType: "application/json",
        Accept: "application/json",
        Body: Buffer.from(body),
      })
    );
    return JSON.parse(Buffer.from(res.Body ?? new Uint8Array()).toString("utf8"));
  }
  const url = process.env.DECIDER_URL ?? "http://127.0.0.1:8099/invocations";
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function main(): Promise<void> {
  let correct = 0;
  const byCertainty: Record<string, { right: number; wrong: number }> = {};
  const latencies: number[] = [];
  for (const c of cases) {
    const { state } = buildDeciderState(c.text);
    const started = Date.now();
    const answer = parseDeciderResponse(await ask(JSON.stringify(buildDeciderRequest(state))));
    latencies.push(Date.now() - started);
    const ok = answer.verdict === c.gold;
    if (ok) correct += 1;
    const bucket = (byCertainty[answer.certainty] ??= { right: 0, wrong: 0 });
    ok ? (bucket.right += 1) : (bucket.wrong += 1);
    const checks = answer.checks
      .map((k) => `${k.passes ? "+" : "-"}${k.id}=${k.pSimple.toFixed(2)}`)
      .join(" ");
    console.log(
      `${ok ? " " : "x"} ${c.id.padEnd(13)} ${c.gold.padEnd(7)} -> ${answer.verdict.padEnd(7)} ` +
        `${(answer.probability * 100).toFixed(0).padStart(3)}% ${answer.certainty.padEnd(6)} ${checks}`
    );
  }
  latencies.sort((a, b) => a - b);
  console.log(
    `\n${correct}/${cases.length} correct. By certainty: ${JSON.stringify(byCertainty)}. ` +
      `Round trip median ${latencies[Math.floor(latencies.length / 2)]} ms, max ${latencies[latencies.length - 1]} ms.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
