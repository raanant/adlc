import { DeleteEndpointCommand, SageMakerClient } from "@aws-sdk/client-sagemaker";
import type { CloudFormationCustomResourceEvent, Context } from "aws-lambda";
import { describeDeciderEndpoint, isEndpointNotFound } from "../shared/decider-endpoint";

const ENDPOINT_NAMES = (process.env.DECIDER_ENDPOINT_NAMES ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const client = new SageMakerClient({});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startDelete(endpointName: string): Promise<void> {
  const described = await describeDeciderEndpoint(client, endpointName);
  if (described.state === "NOT_DEPLOYED" || described.state === "Deleting") return;
  try {
    await client.send(new DeleteEndpointCommand({ EndpointName: endpointName }));
    console.log("decider endpoint deletion started", { endpointName, state: described.state });
  } catch (error) {
    if (!isEndpointNotFound(error)) throw error;
  }
}

/**
 * Custom resource (cdk.custom-resources Provider framework) that deletes the on-demand decider
 * endpoints (CPU and GPU) when the stack is deleted. The endpoints are created from the Settings
 * tab, outside CloudFormation, so without this a `cdk destroy` would leave billed endpoints
 * running. Create and Update do nothing.
 */
export const handler = async (
  event: CloudFormationCustomResourceEvent,
  context: Context
): Promise<{ PhysicalResourceId: string }> => {
  // Unchanged across updates, so adding an endpoint name never replaces the resource.
  const physicalResourceId = "decider-endpoint-cleanup-adlc-poc-decider";
  if (event.RequestType !== "Delete" || ENDPOINT_NAMES.length === 0) {
    return { PhysicalResourceId: physicalResourceId };
  }

  await Promise.all(ENDPOINT_NAMES.map(startDelete));
  // Wait for the deletions so the configurations, models and roles go after the endpoints.
  let remaining = ENDPOINT_NAMES;
  while (context.getRemainingTimeInMillis() > 30_000) {
    const states = await Promise.all(
      remaining.map(async (name) => ({ name, state: (await describeDeciderEndpoint(client, name)).state }))
    );
    remaining = states.filter((s) => s.state !== "NOT_DEPLOYED").map((s) => s.name);
    if (remaining.length === 0) {
      console.log("decider endpoints are deleted");
      return { PhysicalResourceId: physicalResourceId };
    }
    await sleep(15_000);
  }
  // DeleteEndpoint was accepted; it finishes on its own. Do not block the stack deletion.
  console.warn("decider endpoints are still deleting; continuing the stack deletion", { remaining });
  return { PhysicalResourceId: physicalResourceId };
};
