import { DescribeEndpointCommand, type SageMakerClient } from "@aws-sdk/client-sagemaker";

/**
 * State of the on-demand Strands Decider endpoint. NOT_DEPLOYED means no endpoint exists (the
 * default: nothing is billed). Every other value is SageMaker's EndpointStatus.
 */
export type DeciderEndpointState =
  | "NOT_DEPLOYED"
  | "Creating"
  | "InService"
  | "Updating"
  | "SystemUpdating"
  | "RollingBack"
  | "Deleting"
  | "OutOfService"
  | "Failed"
  | "UpdateRollbackFailed"
  | "UNKNOWN";

const KNOWN: ReadonlySet<string> = new Set([
  "Creating",
  "InService",
  "Updating",
  "SystemUpdating",
  "RollingBack",
  "Deleting",
  "OutOfService",
  "Failed",
  "UpdateRollbackFailed",
]);

/** States in which the endpoint answers InvokeEndpoint with the configuration it already has. */
export const SERVING_STATES: ReadonlySet<DeciderEndpointState> = new Set([
  "InService",
  "Updating",
  "SystemUpdating",
]);

/** States that change on their own, so the UI keeps polling. */
export const TRANSITIONAL_STATES: ReadonlySet<DeciderEndpointState> = new Set([
  "Creating",
  "Updating",
  "SystemUpdating",
  "RollingBack",
  "Deleting",
]);

export interface DeciderEndpointDescription {
  state: DeciderEndpointState;
  endpointConfigName: string | null;
  creationTime: string | null;
  lastModifiedTime: string | null;
  failureReason: string | null;
}

/** Remove account IDs, ARNs and control characters before a message reaches a browser. */
export function sanitizeAwsMessage(value: unknown, fallback = "request failed"): string {
  const text = typeof value === "string" ? value : "";
  return (
    text
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .replace(/arn:(?:aws[a-zA-Z-]*)?:[^\s,;"]+/g, "[resource]")
      .replace(/\b\d{12}\b/g, "[account]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 400) || fallback
  );
}

export function isEndpointNotFound(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const message = typeof record.message === "string" ? record.message : "";
  return (
    (record.name === "ValidationException" || record.name === "ValidationError") &&
    /could not find endpoint|endpoint .*not found/i.test(message)
  );
}

export async function describeDeciderEndpoint(
  client: SageMakerClient,
  endpointName: string
): Promise<DeciderEndpointDescription> {
  try {
    const res = await client.send(new DescribeEndpointCommand({ EndpointName: endpointName }), {
      abortSignal: AbortSignal.timeout(8_000),
    });
    const status = res.EndpointStatus ?? "";
    return {
      state: KNOWN.has(status) ? (status as DeciderEndpointState) : "UNKNOWN",
      endpointConfigName: res.EndpointConfigName ?? null,
      creationTime: res.CreationTime?.toISOString() ?? null,
      lastModifiedTime: res.LastModifiedTime?.toISOString() ?? null,
      failureReason: res.FailureReason ? sanitizeAwsMessage(res.FailureReason) : null,
    };
  } catch (error) {
    if (isEndpointNotFound(error)) {
      return {
        state: "NOT_DEPLOYED",
        endpointConfigName: null,
        creationTime: null,
        lastModifiedTime: null,
        failureReason: null,
      };
    }
    throw error;
  }
}
