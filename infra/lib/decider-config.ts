/**
 * Settings of the optional Strands Decider endpoints (lib/decision-model.ts). There are two
 * variants of the same model: one on a CPU instance and one on a GPU instance. Each has a fixed
 * endpoint name so that IAM, the decision-model step and the Settings tab can address it before
 * it exists: endpoints are created and deleted on demand, never by `cdk deploy`. Settings picks
 * which one the pipeline uses; a run never uses both.
 */

/**
 * The served checkpoint, pinned to exact Hugging Face commits. The base revision must equal the
 * one the checkpoint's provenance.json records; decider/model-fetch/fetch-model.ts enforces it.
 * Both variants serve these same weights.
 */
export const DECIDER_MODEL = {
  id: "StrandsAgents/strands-decider-12B-gemma4-v1-2610",
  revision: "1202634aec54c890c3e11b8747db62195f116006",
  baseRevision: "707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7",
} as const;

export {
  DECIDER_VARIANT_IDS,
  DEFAULT_DECIDER_VARIANT,
  type DeciderVariantId,
} from "../lambdas/shared/decider-variants";
import type { DeciderVariantId } from "../lambdas/shared/decider-variants";

export interface DeciderVariantConfig {
  id: DeciderVariantId;
  label: string;
  endpointName: string;
  /** torch device inside the container. */
  device: "cpu" | "cuda";
  /** CDK context key that overrides the instance type. */
  contextKey: string;
  instanceTypes: readonly string[];
  defaultInstanceType: string;
  /** Dockerfile and lock file in decider/image/; serve.py is shared. */
  dockerfile: string;
  requirements: string;
  /** EBS volume for the weights, or undefined on instances with local NVMe storage. */
  volumeGb: number | undefined;
  /** SageMaker host image (GPU driver) for GPU variants. */
  inferenceAmiVersion: string | undefined;
}

export const DECIDER_VARIANTS: Record<DeciderVariantId, DeciderVariantConfig> = {
  cpu: {
    id: "cpu",
    label: "CPU",
    endpointName: "adlc-poc-decider",
    device: "cpu",
    contextKey: "deciderInstanceType",
    /**
     * x86_64 CPU types with 64 GiB of memory or more. On CPU the 12B model runs in fp32: its text
     * decoder and token embedding are 11.9B parameters, about 48 GB, plus activations.
     */
    instanceTypes: [
      "ml.r5.2xlarge",
      "ml.r7i.2xlarge",
      "ml.m5.4xlarge",
      "ml.m7i.4xlarge",
      "ml.r5.4xlarge",
      "ml.r7i.4xlarge",
      "ml.c7i.8xlarge",
    ],
    defaultInstanceType: "ml.m5.4xlarge",
    dockerfile: "Dockerfile",
    requirements: "requirements.txt",
    // Room for the checkpoint and its base model (about 24.8 GB) with margin.
    volumeGb: 64,
    inferenceAmiVersion: undefined,
  },
  gpu: {
    id: "gpu",
    label: "GPU",
    endpointName: "adlc-poc-decider-gpu",
    device: "cuda",
    contextKey: "deciderGpuInstanceType",
    /**
     * NVIDIA L40S (48 GB) types. On GPU the model stays in bf16, about 24 GB; the A10G and L4
     * types (24 GB) are too small. They come with a local NVMe disk, so no EBS volume is set.
     */
    instanceTypes: ["ml.g6e.xlarge", "ml.g6e.2xlarge", "ml.g6e.4xlarge"],
    defaultInstanceType: "ml.g6e.xlarge",
    dockerfile: "Dockerfile.gpu",
    requirements: "requirements-gpu.txt",
    volumeGb: undefined,
    // NVIDIA driver 580 (CUDA 13.0). A newer driver runs the image's CUDA 12.6 build of torch;
    // SageMaker lists this host image as compatible with ml.g6e.*.
    inferenceAmiVersion: "al2023-ami-sagemaker-inference-gpu-4-1",
  },
};

/**
 * On-demand SageMaker hosting prices in us-east-1, USD per instance-hour, from the AWS Price List
 * API (2026-11-01 for CPU, 2026-11-02 for GPU). Used only for the cost estimate in Settings.
 */
export const DECIDER_HOURLY_USD_US_EAST_1: Record<string, number> = {
  "ml.r5.2xlarge": 0.605,
  "ml.r7i.2xlarge": 0.635,
  "ml.m5.4xlarge": 0.922,
  "ml.m7i.4xlarge": 0.968,
  "ml.r5.4xlarge": 1.21,
  "ml.r7i.4xlarge": 1.27,
  "ml.c7i.8xlarge": 1.714,
  "ml.g6e.xlarge": 2.6054,
  "ml.g6e.2xlarge": 2.8026,
  "ml.g6e.4xlarge": 3.7553,
};

export function deciderCheckpointFolder(): string {
  return DECIDER_MODEL.id.split("/").pop()!;
}
