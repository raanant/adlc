import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sagemaker from "aws-cdk-lib/aws-sagemaker";
import * as cr from "aws-cdk-lib/custom-resources";
import { ContainerImageBuild, NodejsBuild } from "@cdklabs/deploy-time-build";
import {
  DECIDER_HOURLY_USD_US_EAST_1,
  DECIDER_MODEL,
  DECIDER_VARIANT_IDS,
  DECIDER_VARIANTS,
  type DeciderVariantConfig,
  type DeciderVariantId,
  deciderCheckpointFolder,
} from "./decider-config";

const DECIDER_DIR = path.join(__dirname, "..", "..", "decider");
const IMAGE_DIR = path.join(DECIDER_DIR, "image");
const DOWNLOAD_TIMEOUT_SECONDS = 1800;
// Loading 24 GB of bf16 weights (and, on CPU, converting them to fp32) takes minutes.
const STARTUP_TIMEOUT_SECONDS = 1800;

/** One endpoint variant as the Lambdas see it (passed to them as JSON, see deciderVariantsEnv). */
export interface DeciderVariantResources {
  id: DeciderVariantId;
  label: string;
  endpointName: string;
  endpointArn: string;
  endpointConfigName: string;
  endpointConfigArn: string;
  instanceType: string;
  /** On-demand price per hour, or undefined when the Region has no recorded price. */
  hourlyUsd: number | undefined;
}

/**
 * Everything the optional Strands Decider endpoints need, EXCEPT the endpoints themselves: a
 * private bucket with the pinned weights (shared), and per variant (CPU and GPU) an inference
 * image, an execution role, a log group, a SageMaker model and an endpoint configuration. None
 * of these bill by the hour.
 *
 * The endpoints are created and deleted on demand from the Settings tab
 * (lambdas/api/decider-endpoint.ts), each from its own endpoint configuration. Settings also picks
 * which variant the pipeline uses. Deleting the stack deletes both endpoints first (custom
 * resource below), so `cdk destroy` cannot leave a billed endpoint behind.
 *
 * Security:
 * - Callers need IAM permission sagemaker:InvokeEndpoint on an endpoint (SigV4). The containers
 *   have no authentication of their own and are not reachable any other way.
 * - The SageMaker models run with network isolation; SageMaker supplies the weights from the
 *   private bucket before the container starts.
 * - Each execution role can read only the model's S3 prefix, pull only its own image and write
 *   only its own endpoint's log group; trust is limited to SageMaker in this account and Region.
 * - Weights and code are pinned (decider/README.md).
 *
 * Adapted from strands-labs/strands-decider deploy/sagemaker (Apache-2.0).
 */
export class DecisionModel extends Construct {
  readonly variants: DeciderVariantResources[];

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const stack = cdk.Stack.of(this);

    const checkpointFolder = deciderCheckpointFolder();
    const modelPrefix = `models/${checkpointFolder}/${DECIDER_MODEL.revision}/`;

    // ------------------------------------------------------------------
    // Weights (shared by both variants): fetched from the Hugging Face Hub by CodeBuild during
    // deploy into a private bucket. They are public weights that can be fetched again, so the
    // bucket is not retained.
    // ------------------------------------------------------------------
    const modelBucket = new s3.Bucket(this, "ModelBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const modelData = new NodejsBuild(this, "ModelData", {
      assets: [{ path: path.join(DECIDER_DIR, "model-fetch"), extractPath: "fetch" }],
      nodejsVersion: 22,
      computeType: codebuild.ComputeType.MEDIUM,
      buildEnvironment: {
        MODEL: DECIDER_MODEL.id,
        MODEL_REVISION: DECIDER_MODEL.revision,
        BASE_REVISION: DECIDER_MODEL.baseRevision,
      },
      buildCommands: [
        "npm ci --no-audit --no-fund",
        'npx tsx fetch-model.ts "$MODEL" "$MODEL_REVISION" "$BASE_REVISION" model',
      ],
      outputSourceDirectory: "model",
      destinationBucket: modelBucket,
      destinationKeyPrefix: modelPrefix,
    });

    const variantResources: DeciderVariantResources[] = [];
    const cleanupDependencies: Construct[] = [];
    for (const variantId of DECIDER_VARIANT_IDS) {
      const variant = DECIDER_VARIANTS[variantId];
      // The CPU variant keeps the construct IDs it had before the GPU variant existed, so an
      // update does not recreate its image repository, role or log group.
      const idPrefix = variantId === "cpu" ? "" : "Gpu";
      const instanceType: string = this.node.tryGetContext(variant.contextKey) ?? variant.defaultInstanceType;
      if (!variant.instanceTypes.includes(instanceType)) {
        throw new Error(
          `${variant.contextKey} ${instanceType} is not supported; choose one of ${variant.instanceTypes.join(", ")}`
        );
      }

      // Inference image: built by CodeBuild during deploy (linux/amd64) into its own ECR
      // repository with scan-on-push. It holds no weights. Only this variant's Dockerfile, lock
      // file and the shared serve.py are uploaded as the build context.
      const imageFiles = [variant.dockerfile, variant.requirements, "serve.py"];
      const image = new ContainerImageBuild(this, `${idPrefix}Image`, {
        directory: IMAGE_DIR,
        // Docker's default name needs no flag; leaving it out keeps the CPU build unchanged.
        ...(variant.dockerfile === "Dockerfile" ? {} : { file: variant.dockerfile }),
        exclude: ["*", ...imageFiles.map((f) => `!${f}`)],
        ignoreMode: cdk.IgnoreMode.DOCKER,
        platform: ecrAssets.Platform.LINUX_AMD64,
      });

      // Created up front so it has a retention period; SageMaker writes into it.
      const logGroupName = `/aws/sagemaker/Endpoints/${variant.endpointName}`;
      const logGroup = new logs.LogGroup(this, `${idPrefix}EndpointLogs`, {
        logGroupName,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const role = new iam.Role(this, `${idPrefix}ExecutionRole`, {
        description: `Execution role of the ADLC PoC Strands Decider SageMaker model (${variant.label})`,
        // Confused-deputy guard in the form AWS documents for SageMaker inference.
        assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com", {
          conditions: {
            ArnLike: {
              "aws:SourceArn": `arn:${cdk.Aws.PARTITION}:sagemaker:${stack.region}:${stack.account}:*`,
            },
          },
        }),
      });
      // The CreateModel minimum (s3:GetObject + s3:ListBucket), limited to the model's prefix.
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [modelBucket.arnForObjects(`${modelPrefix}*`)],
        })
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["s3:ListBucket"],
          resources: [modelBucket.bucketArn],
          conditions: { StringLike: { "s3:prefix": [modelPrefix, `${modelPrefix}*`] } },
        })
      );
      image.repository.grantPull(role);
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogStreams"],
          resources: [logGroup.logGroupArn],
        })
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["logs:CreateLogGroup"],
          resources: [
            `arn:${cdk.Aws.PARTITION}:logs:${stack.region}:${stack.account}:log-group:${logGroupName}`,
          ],
        })
      );
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ["cloudwatch:PutMetricData"],
          resources: ["*"], // PutMetricData has no resource type; scoped by namespace instead.
          conditions: { StringEquals: { "cloudwatch:namespace": "/aws/sagemaker/Endpoints" } },
        })
      );

      const model = new sagemaker.CfnModel(this, `${idPrefix}Model`, {
        executionRoleArn: role.roleArn,
        enableNetworkIsolation: true,
        primaryContainer: {
          image: image.imageUri,
          modelDataSource: {
            s3DataSource: {
              s3Uri: modelBucket.s3UrlForObject(modelPrefix),
              s3DataType: "S3Prefix",
              compressionType: "None",
            },
          },
          environment: {
            // decider/model-fetch layout: /opt/ml/model/<checkpoint>/ and /opt/ml/model/base/.
            DECIDER_CHECKPOINT: `/opt/ml/model/${checkpointFolder}`,
            DECIDER_DEVICE: variant.device,
          },
        },
      });
      // The role's policy must exist before SageMaker checks the image pull, and the weights must
      // be in S3 before SageMaker copies them.
      model.node.addDependency(role, modelData);

      const endpointConfigName = `${variant.endpointName}-${configHash(variant, instanceType, imageFiles)}`;
      const endpointConfig = new sagemaker.CfnEndpointConfig(this, `${idPrefix}EndpointConfig`, {
        endpointConfigName,
        productionVariants: [
          {
            variantName: "AllTraffic",
            modelName: model.attrModelName,
            instanceType,
            initialInstanceCount: 1,
            initialVariantWeight: 1,
            // The GPU types come with a local NVMe disk, so no EBS volume is requested for them.
            ...(variant.volumeGb === undefined ? {} : { volumeSizeInGb: variant.volumeGb }),
            ...(variant.inferenceAmiVersion === undefined
              ? {}
              : { inferenceAmiVersion: variant.inferenceAmiVersion }),
            // Copying about 24.8 GB from S3 and loading the weights takes minutes.
            modelDataDownloadTimeoutInSeconds: DOWNLOAD_TIMEOUT_SECONDS,
            containerStartupHealthCheckTimeoutInSeconds: STARTUP_TIMEOUT_SECONDS,
          },
        ],
      });

      variantResources.push({
        id: variantId,
        label: variant.label,
        endpointName: variant.endpointName,
        endpointArn: stack.formatArn({
          service: "sagemaker",
          resource: "endpoint",
          resourceName: variant.endpointName,
        }),
        endpointConfigName,
        endpointConfigArn: stack.formatArn({
          service: "sagemaker",
          resource: "endpoint-config",
          resourceName: endpointConfigName,
        }),
        instanceType,
        hourlyUsd:
          !cdk.Token.isUnresolved(stack.region) && stack.region === "us-east-1"
            ? DECIDER_HOURLY_USD_US_EAST_1[instanceType]
            : undefined,
      });
      cleanupDependencies.push(endpointConfig, model, role, logGroup);
    }
    this.variants = variantResources;

    // ------------------------------------------------------------------
    // Stack deletion: delete both on-demand endpoints before their configurations, models and
    // roles.
    // ------------------------------------------------------------------
    const endpointNames = variantResources.map((v) => v.endpointName);
    const cleanupFn = new NodejsFunction(this, "EndpointCleanupFn", {
      entry: path.join(__dirname, "..", "lambdas", "custom", "decider-endpoint-cleanup.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(14),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { externalModules: [], minify: true, sourceMap: false },
      environment: { DECIDER_ENDPOINT_NAMES: endpointNames.join(",") },
    });
    cleanupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:DescribeEndpoint", "sagemaker:DeleteEndpoint"],
        resources: this.endpointArns,
      })
    );
    const cleanupProvider = new cr.Provider(this, "EndpointCleanupProvider", {
      onEventHandler: cleanupFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    const cleanup = new cdk.CustomResource(this, "EndpointCleanup", {
      serviceToken: cleanupProvider.serviceToken,
      resourceType: "Custom::DeciderEndpointCleanup",
      properties: { EndpointNames: endpointNames },
    });
    // Created after (so deleted before) everything an endpoint uses.
    cleanup.node.addDependency(...cleanupDependencies);
  }

  get endpointArns(): string[] {
    return this.variants.map((v) => v.endpointArn);
  }

  get endpointConfigArns(): string[] {
    return this.variants.map((v) => v.endpointConfigArn);
  }

  variant(id: DeciderVariantId): DeciderVariantResources {
    const found = this.variants.find((v) => v.id === id);
    if (!found) throw new Error(`no decider variant ${id}`);
    return found;
  }
}

/**
 * A fixed, lowercase, content-addressed name: IAM can scope CreateEndpoint to exactly this
 * configuration (SageMaker ARNs use lowercase names), and any change that replaces the
 * configuration (image, weights, instance type, host image, timeouts) also changes its name,
 * which CloudFormation requires for a custom-named resource.
 */
function configHash(variant: DeciderVariantConfig, instanceType: string, imageFiles: string[]): string {
  const files = Object.fromEntries(
    imageFiles.map((f) => [f, createHash("sha256").update(readFileSync(path.join(IMAGE_DIR, f))).digest("hex")])
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        files,
        model: DECIDER_MODEL,
        device: variant.device,
        instanceType,
        volume: variant.volumeGb ?? null,
        ami: variant.inferenceAmiVersion ?? null,
        download: DOWNLOAD_TIMEOUT_SECONDS,
        startup: STARTUP_TIMEOUT_SECONDS,
        configVersion: 2,
      })
    )
    .digest("hex")
    .slice(0, 12);
}

/** The variants as the Lambdas read them (env DECIDER_VARIANTS; see shared/decider-endpoint.ts). */
export function deciderVariantsEnv(variants: DeciderVariantResources[]): string {
  return JSON.stringify(
    variants.map((v) => ({
      id: v.id,
      label: v.label,
      endpointName: v.endpointName,
      endpointConfigName: v.endpointConfigName,
      instanceType: v.instanceType,
      hourlyUsd: v.hourlyUsd ?? null,
    }))
  );
}
