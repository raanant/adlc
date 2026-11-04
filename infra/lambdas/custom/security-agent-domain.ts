import * as https from "node:https";
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";

/**
 * Custom resource (cdk custom-resources Provider framework) for the AWS Security Agent target
 * domain that AdlcPocStack registers for the CloudFront UI, with HTTP-route verification.
 *
 * Phase "token":  read the verification token of the target domain, so the stack can publish it
 *                 at the route path on the UI distribution.
 * Phase "verify": after the token is published, ask Security Agent to verify the domain and wait
 *                 for the outcome. Verification is reported, never fatal: without it pentests are
 *                 refused (the run records why), while code reviews still work.
 *
 * Delete does nothing; CloudFormation deletes the target domain itself.
 */

const REGION = process.env.AWS_REGION ?? "us-east-1";
/** The route path Security Agent reads for HTTP-route verification (its user guide). */
export const VERIFICATION_ROUTE = ".well-known/aws/securityagent-domain-verification.json";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,512}$/;
const VERIFY_WAIT_MS = 5 * 60_000;

const signer = new SignatureV4({
  credentials: defaultProvider(),
  region: REGION,
  service: "securityagent",
  sha256: Sha256,
});

function sanitize(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/arn:(?:aws[a-zA-Z-]*)?:[^\s,;"]+/g, "[resource]")
    .replace(/\b\d{12}\b/g, "[account]")
    .slice(0, 300);
}

async function call(operation: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hostname = `securityagent.${REGION}.api.aws`;
  const path = `/${operation}`;
  const payload = JSON.stringify(body);
  const signed = await signer.sign({
    method: "POST",
    protocol: "https:",
    hostname,
    path,
    headers: { host: hostname, "content-type": "application/json" },
    body: payload,
  });
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: "POST", headers: signed.headers, timeout: 20_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`${operation} returned HTTP ${res.statusCode}: ${sanitize(text)}`));
            return;
          }
          try {
            resolve(JSON.parse(text) as Record<string, unknown>);
          } catch {
            reject(new Error(`${operation} returned a non-JSON body`));
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`${operation} timed out`)));
    req.on("error", reject);
    req.end(payload);
  });
}

interface TargetDomain {
  domainName?: string;
  verificationStatus?: string;
  verificationStatusReason?: string;
  verificationDetails?: { method?: string; httpRoute?: { token?: string; routePath?: string } };
}

async function getTargetDomain(id: string): Promise<TargetDomain> {
  const res = await call("BatchGetTargetDomains", { targetDomainIds: [id] });
  const domains = Array.isArray(res.targetDomains) ? (res.targetDomains as TargetDomain[]) : [];
  if (domains.length !== 1) throw new Error(`target domain ${id} was not found`);
  return domains[0];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const handler = async (
  event: CloudFormationCustomResourceEvent,
  context: Context
): Promise<{ PhysicalResourceId: string; Data?: Record<string, string> }> => {
  const props = event.ResourceProperties as unknown as { Phase?: string; TargetDomainId?: string };
  const id = String(props.TargetDomainId ?? "");
  const phase = props.Phase;
  if (event.RequestType === "Delete") return { PhysicalResourceId: event.PhysicalResourceId };
  if (!ID_PATTERN.test(id)) throw new Error("TargetDomainId is missing or malformed");

  if (phase === "token") {
    const domain = await getTargetDomain(id);
    const route = domain.verificationDetails?.httpRoute;
    const token = route?.token ?? "";
    const routePath = (route?.routePath ?? "").replace(/^\/+/, "");
    if (!TOKEN_PATTERN.test(token)) throw new Error("the target domain has no usable HTTP-route token");
    if (routePath && routePath !== VERIFICATION_ROUTE) {
      throw new Error(`Security Agent expects the token at ${sanitize(routePath)}, not ${VERIFICATION_ROUTE}`);
    }
    return { PhysicalResourceId: `${id}-token`, Data: { Token: token } };
  }

  if (phase === "verify") {
    let status = "UNKNOWN";
    let reason = "";
    try {
      const started = await call("VerifyTargetDomain", { targetDomainId: id });
      status = String(started.status ?? "PENDING");
      reason = String(started.verificationStatusReason ?? "");
      const deadline = Date.now() + Math.min(VERIFY_WAIT_MS, context.getRemainingTimeInMillis() - 30_000);
      while (status === "PENDING" && Date.now() < deadline) {
        await sleep(10_000);
        const domain = await getTargetDomain(id);
        status = domain.verificationStatus ?? "UNKNOWN";
        reason = domain.verificationStatusReason ?? "";
      }
    } catch (error) {
      status = "ERROR";
      reason = error instanceof Error ? error.message : "verification request failed";
    }
    if (status === "VERIFIED") console.log("target domain verified", { id });
    else console.warn("target domain is not verified; pentests will be refused until it is", { id, status, reason: sanitize(reason) });
    return {
      PhysicalResourceId: `${id}-verification`,
      Data: { Status: status, Reason: sanitize(reason) || "-" },
    };
  }

  throw new Error(`unknown Phase ${String(phase)}`);
};
