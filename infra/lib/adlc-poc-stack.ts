import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Auth from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as apigwv2Int from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as agentcore from "aws-cdk-lib/aws-bedrockagentcore";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { DECIDER_MODEL } from "./decider-config";
import { ANALYSIS_MODELS } from "../lambdas/shared/workflow";
import { DecisionModel, deciderVariantsEnv } from "./decision-model";
import { INITIAL_ATTEMPT_BUDGET, REVIEW_TIMEOUT_DAYS } from "../lambdas/shared/review";
import {
  SECURITY_AGENT_VERIFICATION_ROUTE,
  SECURITY_REVIEW_PREFIX,
  SecurityAgent,
} from "./security-agent";

/** Read a boolean CDK context value: `-c key=false` arrives as a string. */
function contextFlag(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error(`context value must be true or false, got ${String(value)}`);
}

const BASE_BRANCH = "main";
// Independent validation uses a fixed Sonnet model, separate from the analysis model chosen on
// the start form and from the implementation engine (Kiro CLI or its Haiku fallback).
const VALIDATE_MODEL_ID = "us.anthropic.claude-sonnet-5-5";

const KIRO_KEY_SECRET_NAME = "adlc-poc/kiro-api-key";

export class AdlcPocStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ------------------------------------------------------------------
    // Target repository: dummy todo app with the two seeded bugs
    // ------------------------------------------------------------------
    const repo = new codecommit.Repository(this, "TodoRepo", {
      repositoryName: "adlc-poc-todo-service",
      description:
        "ADLC PoC target repo: todo-service with BUG-001 (build break) and BUG-002 (SQL injection)",
      code: codecommit.Code.fromDirectory(
        path.join(__dirname, "..", "..", "dummy-app"),
        BASE_BRANCH
      ),
    });

    // ------------------------------------------------------------------
    // Encrypted Kiro API key placeholder. The user replaces PLACEHOLDER
    // with a real ksk_ key after deployment; no key enters CDK context or
    // CloudFormation parameters.
    // ------------------------------------------------------------------
    const kiroKeySecret = new secretsmanager.Secret(this, "KiroApiKeySecret", {
      secretName: KIRO_KEY_SECRET_NAME,
      description:
        "Kiro CLI API key (ksk_...) for the ADLC PoC coding agent. PLACEHOLDER = use Bedrock fallback.",
      secretStringValue: cdk.SecretValue.unsafePlainText("PLACEHOLDER"),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });

    // ------------------------------------------------------------------
    // Runs table
    // ------------------------------------------------------------------
    const runsTable = new dynamodb.Table(this, "RunsTable", {
      partitionKey: { name: "runId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const repoControlTable = new dynamodb.Table(this, "RepoControlTable", {
      partitionKey: { name: "repoBranch", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const resetAuditTable = new dynamodb.Table(this, "ResetAuditTable", {
      partitionKey: { name: "actionId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    // Deployment-wide settings changed from the Settings tab (today: which decision-model
    // endpoint the pipeline uses). One item per setting; a missing item means the default.
    const settingsTable = new dynamodb.Table(this, "SettingsTable", {
      partitionKey: { name: "settingKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const contextTable = new dynamodb.Table(this, "ContextTable", {
      partitionKey: { name: "ownerSub", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "itemKey", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const contextBucket = new s3.Bucket(this, "ContextBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedOrigins: ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT],
          allowedHeaders: ["content-type"],
          exposedHeaders: ["etag"],
          maxAge: 300,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
      autoDeleteObjects: true,
    });

    // ------------------------------------------------------------------
    // Coding agent on Bedrock AgentCore Runtime (Kiro CLI + fallback)
    // ------------------------------------------------------------------
    const agentImage = new ecrAssets.DockerImageAsset(this, "AgentImage", {
      directory: path.join(__dirname, "..", "..", "agent"),
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    const agentRole = new iam.Role(this, "AgentRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`,
          },
        },
      }),
      description: "Execution role for the ADLC PoC coding agent runtime",
    });
    // Image pull (CDK asset ECR repo). grantPull includes all repository-scoped
    // layer/image actions; GetAuthorizationToken is necessarily resource "*".
    agentImage.repository.grantPull(agentRole);
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ecr:GetAuthorizationToken"],
        resources: ["*"],
      })
    );
    // Logs, metrics, traces (AgentCore observability)
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams",
        ],
        resources: [
          `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
        ],
      })
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "xray:PutTraceSegments",
          "xray:PutTelemetryRecords",
        ],
        resources: ["*"],
      })
    );
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
        },
      })
    );
    // Workload identity token (required by AgentCore runtime)
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "bedrock-agentcore:GetWorkloadAccessToken",
          "bedrock-agentcore:GetWorkloadAccessTokenForJWT",
          "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        ],
        resources: [
          `arn:aws:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default*`,
        ],
      })
    );
    // Task permissions: clone/push the one repo, read the Kiro key. The agent
    // runs Kiro CLI only — it has no Bedrock model access by design.
    repo.grantPullPush(agentRole);
    kiroKeySecret.grantRead(agentRole);
    agentRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [runsTable.tableArn],
      })
    );

    const agentRuntime = new agentcore.CfnRuntime(this, "CodingAgentRuntime", {
      agentRuntimeName: "adlc_poc_coding_agent",
      description:
        "ADLC PoC coding agent: Kiro CLI (headless) only; clones the todo repo, implements approved fixes, pushes fix branches",
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: agentImage.imageUri },
      },
      networkConfiguration: { networkMode: "PUBLIC" },
      protocolConfiguration: "HTTP",
      roleArn: agentRole.roleArn,
      environmentVariables: {
        REPO_NAME: repo.repositoryName,
        REPO_REGION: this.region,
        RUNS_TABLE: runsTable.tableName,
        KIRO_KEY_SECRET_ARN: kiroKeySecret.secretArn,
      },
    });
    // AgentCore Runtime platform V2: a session starts by restoring a snapshot taken after
    // agent/app.py's start-up (imports and constants only), instead of booting the container, so
    // cold starts are short and steady, and memory is billed by use. app.py keeps per-request
    // work (AWS clients, credentials, temp dirs, timestamps, Kiro CLI processes) in the handler,
    // as V2 requires. CloudFormation supports PlatformVersion; aws-cdk-lib 2.220's typed
    // CfnRuntime props do not (later releases add `platformVersion`), hence the override.
    // Roll back by setting "V1".
    agentRuntime.addPropertyOverride("PlatformVersion", "V2");
    // CfnRuntime references only the role ARN, so CloudFormation otherwise has
    // no dependency on the separately generated inline policy and may validate
    // ECR access before that policy is attached.
    const agentDefaultPolicy = agentRole.node.tryFindChild("DefaultPolicy");
    if (agentDefaultPolicy) {
      agentRuntime.node.addDependency(agentDefaultPolicy);
    }

    // ------------------------------------------------------------------
    // Step Lambdas
    // ------------------------------------------------------------------
    const stepEnv = {
      RUNS_TABLE: runsTable.tableName,
      REPO_NAME: repo.repositoryName,
      BASE_BRANCH,
      REPO_CONTROL_TABLE: repoControlTable.tableName,
    };
    const stepFn = (name: string, entry: string, extra?: {
      env?: Record<string, string>;
      timeout?: cdk.Duration;
      memory?: number;
    }) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, "..", "lambdas", "steps", entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: extra?.timeout ?? cdk.Duration.minutes(2),
        memorySize: extra?.memory ?? 512,
        logRetention: logs.RetentionDays.ONE_WEEK,
        bundling: { externalModules: [], minify: true, sourceMap: false },
        environment: { ...stepEnv, ...(extra?.env ?? {}) },
      });

    const triageFn = stepFn("TriageFn", "triage.ts", {
      env: {
        CONTEXT_TABLE: contextTable.tableName,
        CONTEXT_BUCKET: contextBucket.bucketName,
      },
      memory: 1024,
    });
    const draftFn = stepFn("DraftFn", "draft.ts");
    // Optional informative second opinion from the Strands Decider decision model, on a CPU or a
    // GPU endpoint. The stack holds everything but the billed endpoints, which are deployed and
    // stopped from Settings; Settings also picks the one the pipeline uses. The step records its
    // answer and never changes routing.
    const decider = new DecisionModel(this, "DecisionModelHosting");
    const DECIDER_VARIANTS = deciderVariantsEnv(decider.variants);
    const decisionModelFn = stepFn("DecisionModelFn", "decision-model.ts", {
      env: { DECIDER_VARIANTS },
      timeout: cdk.Duration.seconds(90),
    });
    const autoDecisionFn = stepFn("AutoDecisionFn", "auto-decision.ts");
    const awaitApprovalFn = stepFn("AwaitApprovalFn", "await-approval.ts");
    const awaitReviewFn = stepFn("AwaitReviewFn", "await-review.ts");
    const implementFn = stepFn("ImplementFn", "implement.ts", {
      env: { AGENT_RUNTIME_ARN: agentRuntime.attrAgentRuntimeArn },
      timeout: cdk.Duration.minutes(15),
      memory: 1024,
    });
    const validateFn = stepFn("ValidateFn", "validate.ts", {
      env: { VALIDATE_MODEL_ID },
    });
    const reportFn = stepFn("ReportFn", "report.ts");
    const awaitSecurityGateFn = stepFn("AwaitSecurityGateFn", "await-security-gate.ts");
    const securityStartFn = stepFn("SecurityStartFn", "security-review-start.ts", {
      timeout: cdk.Duration.minutes(5),
      memory: 1024,
    });
    const securityCheckFn = stepFn("SecurityCheckFn", "security-review-check.ts", {
      timeout: cdk.Duration.minutes(2),
    });
    // AWS Security Agent (agent space, service role, verified target domain) is provisioned by
    // this stack after the CloudFront distribution exists (see "Security review" below).
    // Opt out with: cdk deploy -c securityAgent=false
    const securityAgentEnabled = contextFlag(this.node.tryGetContext("securityAgent"), true);
    securityStartFn.addEnvironment("CONTEXT_BUCKET", contextBucket.bucketName);
    // Writes the source archive to security-review/ only.
    securityStartFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject"],
      resources: [contextBucket.arnForObjects(`${SECURITY_REVIEW_PREFIX}*`)],
    }));
    repo.grantRead(securityStartFn);

    for (const fn of [triageFn, draftFn, autoDecisionFn, awaitApprovalFn, awaitReviewFn, implementFn, validateFn, reportFn, securityStartFn, securityCheckFn, awaitSecurityGateFn]) {
      runsTable.grantReadWriteData(fn);
    }
    // Bedrock access, limited to the models each function uses. A US cross-Region inference
    // profile is authorized on the profile itself and on its foundation model in every Region it
    // routes to; the foundation-model grant only applies through the profile.
    const invokeThroughProfiles = (profileIds: readonly string[]) => {
      const profileArns = profileIds.map(
        (id) => `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${id}`
      );
      return [
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: profileArns,
        }),
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel"],
          resources: profileIds.map(
            (id) => `arn:aws:bedrock:*::foundation-model/${id.replace(/^us\./, "")}`
          ),
          conditions: { StringEquals: { "bedrock:InferenceProfileArn": profileArns } },
        }),
      ];
    };
    const analysisModelIds = ANALYSIS_MODELS.map((model) => model.id);
    for (const statement of invokeThroughProfiles(analysisModelIds)) {
      triageFn.addToRolePolicy(statement);
      draftFn.addToRolePolicy(statement);
    }
    for (const statement of invokeThroughProfiles([VALIDATE_MODEL_ID])) {
      validateFn.addToRolePolicy(statement);
    }
    repo.grantRead(triageFn);
    triageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:Query"],
        resources: [contextTable.tableArn],
      })
    );
    triageFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`${contextBucket.bucketArn}/users/*`],
      })
    );
    // Decision-model step: least privilege. It only updates the run record and invokes the
    // decider endpoints (the run's variant picks one); the bug report, the variant and the LLM
    // verdict arrive in the state input.
    decisionModelFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [runsTable.tableArn],
      })
    );
    decisionModelFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:InvokeEndpoint"],
        resources: decider.endpointArns,
      })
    );
    repo.grantRead(draftFn);
    repo.grantRead(validateFn);
    repo.grantRead(implementFn);
    repo.grantRead(securityStartFn);
    repoControlTable.grantReadWriteData(implementFn);
    implementFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          agentRuntime.attrAgentRuntimeArn,
          `${agentRuntime.attrAgentRuntimeArn}/*`,
        ],
      })
    );

    // ------------------------------------------------------------------
    // Workflow v2: triage recommendation -> generate both artifacts -> optional
    // automatic SIMPLE approval or human execution gate -> implement -> validate
    // -> (fix loop, max 3) -> report. COMPLEX fixes always use the human gate.
    // The approved artifact remains frozen for every implementation retry.
    // ------------------------------------------------------------------
    const triage = new tasks.LambdaInvoke(this, "Triage", {
      lambdaFunction: triageFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "analysisModel.$": "$.analysisModel",
        "triageInstruction.$": "$.triageInstruction",
        "ownerSub.$": "$.ownerSub",
        "includeContext.$": "$.includeContext",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.triage",
    });

    const decisionModel = new tasks.LambdaInvoke(this, "DecisionModel", {
      lambdaFunction: decisionModelFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "variant.$": "$.decisionModelVariant",
        "triage.$": "$.triage",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.decisionModel",
    });

    const draft = new tasks.LambdaInvoke(this, "Draft", {
      lambdaFunction: draftFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "analysisModel.$": "$.analysisModel",
        "triage.$": "$.triage",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.draft",
    });

    const autoDecision = new tasks.LambdaInvoke(this, "AutoDecision", {
      lambdaFunction: autoDecisionFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "draft.$": "$.draft",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.approval",
    });

    const awaitApproval = new tasks.LambdaInvoke(this, "AwaitApproval", {
      lambdaFunction: awaitApprovalFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        taskToken: sfn.JsonPath.taskToken,
      }),
      resultPath: "$.approval",
      taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(24)),
    });

    const implement = new tasks.LambdaInvoke(this, "Implement", {
      lambdaFunction: implementFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "kiroModel.$": "$.kiroModel",
        "executionMode.$": "$.approval.selectedMode",
        "approvedArtifact.$": "$.approval.selectedArtifact",
        "validation.$": "$.validation",
      }),
      payloadResponseOnly: true,
      resultPath: "$.implementResult",
    });

    const seedValidation = new sfn.Pass(this, "SeedValidation", {
      result: sfn.Result.fromObject({ issues: [] }),
      resultPath: "$.validation",
    });
    // Automatic implementation attempts before the review gate; "retry with guidance" raises it.
    const seedAttemptBudget = new sfn.Pass(this, "SeedAttemptBudget", {
      result: sfn.Result.fromObject({ attemptBudget: INITIAL_ATTEMPT_BUDGET }),
      resultPath: "$.budget",
    });

    // Review gate: when automatic attempts cannot finish the run, it waits for a person to
    // accept the fix (with a reason), retry with guidance, or close it
    // (POST /runs/{runId}/review-decision, lambdas/api/review-decision.ts).
    const awaitReview = new tasks.LambdaInvoke(this, "AwaitReview", {
      lambdaFunction: awaitReviewFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        taskToken: sfn.JsonPath.taskToken,
        "validation.$": "$.validation",
        "budget.$": "$.budget",
      }),
      resultPath: "$.review",
      taskTimeout: sfn.Timeout.duration(cdk.Duration.days(REVIEW_TIMEOUT_DAYS)),
    });

    const validate = new tasks.LambdaInvoke(this, "Validate", {
      lambdaFunction: validateFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "bugText.$": "$.bugText",
        "executionMode.$": "$.approval.selectedMode",
        "approvedArtifact.$": "$.approval.selectedArtifact",
        "implementResult.$": "$.implementResult",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.validation",
    });

    const reportTask = (id: string, mode: string) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: reportFn,
        payload: sfn.TaskInput.fromObject({
          "runId.$": "$.runId",
          mode,
        }),
        payloadResponseOnly: true,
        resultPath: "$.report",
      });

    const reportSuccess = reportTask("ReportSuccess", "success");
    const reportReviewClosed = reportTask("ReportReviewClosed", "reviewClosed");
    const reportReviewTimeout = reportTask("ReportReviewTimeout", "reviewTimeout");
    const reportCancelled = reportTask("ReportCancelled", "cancelled");

    const reportFailed = new tasks.LambdaInvoke(this, "ReportFailed", {
      lambdaFunction: reportFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        mode: "failed",
        "error.$": "$.error",
        "failureStage.$": "$.failure.failureStage",
      }),
      payloadResponseOnly: true,
      retryOnServiceExceptions: false,
      resultPath: "$.report",
    });

    const transientLambdaErrors = [
      "Lambda.ServiceException",
      "Lambda.AWSLambdaException",
      "Lambda.SdkClientException",
      "Lambda.TooManyRequestsException",
    ];
    for (const task of [triage, decisionModel, draft, validate]) {
      task.addRetry({
        errors: transientLambdaErrors,
        interval: cdk.Duration.seconds(2),
        backoffRate: 2,
        maxAttempts: 3,
      });
    }
    reportFailed.addRetry({
      errors: transientLambdaErrors,
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const executionChoice = new sfn.Choice(this, "ExecuteOrCancel?")
      .when(
        sfn.Condition.or(
          sfn.Condition.stringEquals("$.approval.action", "execute"),
          sfn.Condition.booleanEquals("$.approval.approved", true)
        ),
        sfn.Chain.start(seedValidation).next(seedAttemptBudget).next(implement)
      )
      .otherwise(reportCancelled);

    const autoExecuteChoice = new sfn.Choice(this, "AutoExecuteSimple?")
      .when(
        sfn.Condition.and(
          sfn.Condition.booleanEquals("$.autoExecuteSimple", true),
          sfn.Condition.stringEquals("$.triage.complexity", "SIMPLE")
        ),
        autoDecision
      )
      .otherwise(awaitApproval);

    const securityStart = new tasks.LambdaInvoke(this, "SecurityStart", {
      lambdaFunction: securityStartFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "implementResult.$": "$.implementResult",
      }),
      payloadResponseOnly: true,
      resultPath: "$.securityStart",
    });
    securityStart.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    const securityWait = new sfn.Wait(this, "SecurityWait", {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const securityCheck = new tasks.LambdaInvoke(this, "SecurityCheck", {
      lambdaFunction: securityCheckFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "securityStart.$": "$.securityStart",
      }),
      payloadResponseOnly: true,
      resultPath: "$.securityStart",
    });
    securityCheck.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });

    // Security Gate: human decides whether to remediate findings or accept risks
    const awaitSecurityGate = new tasks.LambdaInvoke(this, "AwaitSecurityGate", {
      lambdaFunction: awaitSecurityGateFn,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        taskToken: sfn.JsonPath.taskToken,
        "securityStart.$": "$.securityStart",
      }),
      resultPath: "$.securityDecision",
      taskTimeout: sfn.Timeout.duration(cdk.Duration.hours(24)),
    });

    const securityGateChoice = new sfn.Choice(this, "RemediateOrAccept?")
      .when(
        sfn.Condition.stringEquals("$.securityDecision.action", "remediate"),
        // Loop back: use the remediation bug text, re-triage
        new sfn.Pass(this, "PrepareRemediation", {
          parameters: {
            "runId.$": "$.runId",
            "bugText.$": "$.securityDecision.remediationBugText",
            "kiroModel.$": "$.kiroModel",
            "securityMode.$": "$.securityMode",
            "decisionModelEnabled.$": "$.decisionModelEnabled",
            "autoExecuteSimple": false,
            "workflowVersion": 2,
            "remediationCycle": true,
          },
        }).next(triage)
      )
      .otherwise(reportSuccess);

    // If security review found issues, go to gate; if clean, go to report
    const securityResultChoice = new sfn.Choice(this, "SecurityFindingsExist?")
      .when(
        sfn.Condition.booleanEquals("$.securityStart.passed", true),
        reportSuccess
      )
      .otherwise(awaitSecurityGate);

    awaitSecurityGate.next(securityGateChoice);

    const securityDone = new sfn.Choice(this, "SecurityDone?")
      .when(sfn.Condition.booleanEquals("$.securityStart.complete", true), securityResultChoice)
      .otherwise(securityWait);

    // Async path: start security review but skip to report immediately
    const securityStartAsync = new tasks.LambdaInvoke(this, "SecurityStartAsync", {
      lambdaFunction: securityStartFn,
      payload: sfn.TaskInput.fromObject({
        "runId.$": "$.runId",
        "implementResult.$": "$.implementResult",
      }),
      payloadResponseOnly: true,
      resultPath: "$.securityStart",
    });
    securityStartAsync.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      interval: cdk.Duration.seconds(2),
      backoffRate: 2,
      maxAttempts: 3,
    });
    securityStartAsync.next(reportSuccess);

    // Route based on securityMode: skip | scan (async) | remediate (wait+loop)
    const securityModeChoice = new sfn.Choice(this, "SecurityRemediationEnabled?")
      .when(
        sfn.Condition.stringEquals("$.securityMode", "remediate"),
        securityStart
      )
      .when(
        sfn.Condition.stringEquals("$.securityMode", "scan"),
        securityStartAsync
      )
      .otherwise(reportSuccess); // skip

    // Wire: start → wait → check → done? → (loop or report)
    securityStart.next(securityWait);
    securityWait.next(securityCheck);
    securityCheck.next(securityDone);

    // Retry automatically only while attempts are left AND the validator says another attempt
    // can change the outcome; otherwise a person decides at the review gate.
    const validationChoice = new sfn.Choice(this, "ValidationGreen?")
      .when(sfn.Condition.booleanEquals("$.validation.pass", true), securityModeChoice)
      .when(
        sfn.Condition.and(
          sfn.Condition.booleanEquals("$.validation.pass", false),
          sfn.Condition.or(
            sfn.Condition.isNotPresent("$.validation.retryable"),
            sfn.Condition.booleanEquals("$.validation.retryable", true)
          ),
          sfn.Condition.numberLessThanJsonPath("$.validation.fixAttempts", "$.budget.attemptBudget")
        ),
        implement
      )
      .otherwise(awaitReview);

    // Review decisions. Accept: continue with the fix branch as it is, through security review
    // when the run asked for one; the report records ACCEPTED_BY_REVIEWER, never a green pass.
    const useAcceptedFix = new sfn.Pass(this, "UseAcceptedFix", {
      inputPath: "$.review.acceptedFix",
      resultPath: "$.implementResult",
    });
    useAcceptedFix.next(securityModeChoice);
    // Retry: a larger attempt budget and the (possibly edited) approved artifact, then implement.
    const applyReviewBudget = new sfn.Pass(this, "ApplyReviewBudget", {
      parameters: { "attemptBudget.$": "$.review.attemptBudget" },
      resultPath: "$.budget",
    });
    const applyReviewArtifact = new sfn.Pass(this, "ApplyReviewArtifact", {
      parameters: {
        action: "execute",
        approved: true,
        "selectedMode.$": "$.review.selectedMode",
        "selectedArtifact.$": "$.review.artifact",
      },
      resultPath: "$.approval",
    });
    applyReviewBudget.next(applyReviewArtifact).next(implement);
    const reviewChoice = new sfn.Choice(this, "ReviewDecision?")
      .when(sfn.Condition.stringEquals("$.review.action", "accept"), useAcceptedFix)
      .when(sfn.Condition.stringEquals("$.review.action", "retry"), applyReviewBudget)
      .otherwise(reportReviewClosed);
    awaitReview.next(reviewChoice);
    const reviewTimedOut = new sfn.Pass(this, "ReviewTimedOut", {
      comment: `Nobody decided within ${REVIEW_TIMEOUT_DAYS} days; the run is closed.`,
    });
    reviewTimedOut.next(reportReviewTimeout);
    // Before the generic failure catch below, so a timeout closes the run instead of failing it.
    awaitReview.addCatch(reviewTimedOut, {
      errors: ["States.Timeout"],
      resultPath: "$.reviewTimeout",
    });

    // The decision model is informative only: it runs after triage when the run opts in, and
    // every outcome (including a Lambda-level failure) continues to Draft. AutoExecuteSimple?
    // still reads only $.triage.complexity, the LLM verdict.
    const decisionModelSkipped = new sfn.Pass(this, "DecisionModelSkipped", {
      comment: "The decision-model step failed; the run continues with the LLM triage.",
    });
    decisionModelSkipped.next(draft);
    decisionModel.addCatch(decisionModelSkipped, {
      errors: ["States.ALL"],
      resultPath: "$.decisionModelError",
    });
    decisionModel.next(draft);
    const decisionModelChoice = new sfn.Choice(this, "DecisionModelEnabled?")
      .when(
        sfn.Condition.and(
          sfn.Condition.isPresent("$.decisionModelEnabled"),
          sfn.Condition.booleanEquals("$.decisionModelEnabled", true)
        ),
        decisionModel
      )
      .otherwise(draft);

    triage.next(decisionModelChoice);
    draft.next(autoExecuteChoice);
    autoDecision.next(executionChoice);
    awaitApproval.next(executionChoice);
    implement.next(validate);
    validate.next(validationChoice);

    // Preserve the failing stage before routing every unhandled error to reporting.
    for (const [task, stage] of [
      [triage, "TRIAGE"],
      [draft, "DRAFT"],
      [autoDecision, "AUTO_DECISION"],
      [awaitApproval, "APPROVAL"],
      [awaitReview, "REVIEW"],
      [implement, "IMPLEMENT"],
      [validate, "VALIDATE"],
      [securityStart, "SECURITY_START"],
      [securityCheck, "SECURITY_CHECK"],
      [awaitSecurityGate, "SECURITY_GATE"],
    ] as const) {
      const failureStage = new sfn.Pass(this, `${stage}FailureStage`, {
        result: sfn.Result.fromObject({ failureStage: stage }),
        resultPath: "$.failure",
      });
      failureStage.next(reportFailed);
      task.addCatch(failureStage, {
        errors: ["States.ALL"],
        resultPath: "$.error",
      });
    }

    const stateMachine = new sfn.StateMachine(this, "BugFixWorkflow", {
      definitionBody: sfn.DefinitionBody.fromChainable(triage),
      // The execution gate waits up to 24 h and each of up to 3 review rounds up to 7 days.
      timeout: cdk.Duration.days(23),
      tracingEnabled: true,
      logs: {
        destination: new logs.LogGroup(this, "WorkflowLogs", {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        level: sfn.LogLevel.ALL,
      },
    });

    // ------------------------------------------------------------------
    // Cognito
    // ------------------------------------------------------------------
    const userPool = new cognito.UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
    });
    const userPoolClient = userPool.addClient("WebClient", {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(1),
    });
    const resetterGroup = new cognito.CfnUserPoolGroup(this, "RepoResettersGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "repo-resetters",
      description: "Authenticated PoC users allowed to restore the canonical buggy main branch",
      precedence: 10,
    });

    // ------------------------------------------------------------------
    // API Lambdas + HTTP API with Cognito JWT authorizer
    // ------------------------------------------------------------------
    const apiFn = (name: string, entry: string, env: Record<string, string>) =>
      new NodejsFunction(this, name, {
        entry: path.join(__dirname, "..", "lambdas", "api", entry),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(29),
        memorySize: 256,
        logRetention: logs.RetentionDays.ONE_WEEK,
        bundling: { externalModules: [], minify: true, sourceMap: false },
        environment: env,
      });

    const startRunFn = apiFn("StartRunFn", "start-run.ts", {
      RUNS_TABLE: runsTable.tableName,
      STATE_MACHINE_ARN: stateMachine.stateMachineArn,
      CONTEXT_TABLE: contextTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
    });
    startRunFn.addToRolePolicy(
      new iam.PolicyStatement({
        // The caller's MCP config and the decision-model endpoint picked in Settings.
        actions: ["dynamodb:GetItem"],
        resources: [contextTable.tableArn, settingsTable.tableArn],
      })
    );
    const getRunsFn = apiFn("GetRunsFn", "get-runs.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    const decisionFn = apiFn("DecisionFn", "decision.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    const getModelsFn = apiFn("GetModelsFn", "get-models.ts", {
      AGENT_RUNTIME_ARN: agentRuntime.attrAgentRuntimeArn,
      DECIDER_VARIANTS,
      DECIDER_MODEL_ID: DECIDER_MODEL.id,
      SETTINGS_TABLE: settingsTable.tableName,
    });
    // Reports whether the decision-model endpoint picked in Settings is deployed and in service.
    getModelsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:DescribeEndpoint"],
        resources: decider.endpointArns,
      })
    );
    getModelsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [settingsTable.tableArn],
      })
    );
    // Settings: status, deploy and stop of the two on-demand decision-model endpoints (CPU and
    // GPU), and which one the pipeline uses. Deploy can only create the two endpoint names from
    // the two stack-owned configurations; every action is audited (PutItem/UpdateItem on the
    // audit table) before SageMaker or the setting is changed.
    const deciderEndpointFn = apiFn("DeciderEndpointFn", "decider-endpoint.ts", {
      DECIDER_VARIANTS,
      DECIDER_MODEL_ID: DECIDER_MODEL.id,
      AUDIT_TABLE: resetAuditTable.tableName,
      SETTINGS_TABLE: settingsTable.tableName,
    });
    deciderEndpointFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["sagemaker:DescribeEndpoint", "sagemaker:DeleteEndpoint"],
        resources: decider.endpointArns,
      })
    );
    deciderEndpointFn.addToRolePolicy(
      new iam.PolicyStatement({
        // CreateEndpoint is authorized on both the endpoint and its endpoint configuration.
        actions: ["sagemaker:CreateEndpoint"],
        resources: [...decider.endpointArns, ...decider.endpointConfigArns],
      })
    );
    deciderEndpointFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [resetAuditTable.tableArn],
      })
    );
    deciderEndpointFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem"],
        resources: [settingsTable.tableArn],
      })
    );
    const repositoryReadFn = apiFn("RepositoryReadFn", "repository-read.ts", {
      REPO_NAME: repo.repositoryName,
      RUNS_TABLE: runsTable.tableName,
      BASE_BRANCH,
    });
    const repositoryResetFn = apiFn("RepositoryResetFn", "repository-reset.ts", {
      REPO_NAME: repo.repositoryName,
      RUNS_TABLE: runsTable.tableName,
      REPO_CONTROL_TABLE: repoControlTable.tableName,
      RESET_AUDIT_TABLE: resetAuditTable.tableName,
      BASE_BRANCH,
      RESETTER_GROUP: "repo-resetters",
    });
    const repositoryDeleteFn = apiFn("RepositoryDeleteFn", "repository-delete.ts", {
      REPO_NAME: repo.repositoryName,
      RUNS_TABLE: runsTable.tableName,
      REPO_CONTROL_TABLE: repoControlTable.tableName,
      RESET_AUDIT_TABLE: resetAuditTable.tableName,
      RESETTER_GROUP: "repo-resetters",
    });
    const contextApiFn = apiFn("ContextApiFn", "context.ts", {
      CONTEXT_TABLE: contextTable.tableName,
      CONTEXT_BUCKET: contextBucket.bucketName,
    });
    const mcpApiFn = apiFn("McpApiFn", "mcp.ts", {
      CONTEXT_TABLE: contextTable.tableName,
    });
    mcpApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"],
        resources: [contextTable.tableArn],
      })
    );
    const contextCleanupFn = apiFn("ContextCleanupFn", "context-cleanup.ts", {
      CONTEXT_TABLE: contextTable.tableName,
      CONTEXT_BUCKET: contextBucket.bucketName,
    });

    runsTable.grantReadWriteData(startRunFn);
    runsTable.grantReadData(getRunsFn);
    runsTable.grantReadWriteData(decisionFn);
    stateMachine.grantStartExecution(startRunFn);
    stateMachine.grantTaskResponse(decisionFn);
    // Review gate decisions: reads and claims the run record, then resumes the workflow.
    const reviewDecisionFn = apiFn("ReviewDecisionFn", "review-decision.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    reviewDecisionFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
        resources: [runsTable.tableArn],
      })
    );
    stateMachine.grantTaskResponse(reviewDecisionFn);

    // Update run model: allows changing kiroModel after triage recommendation
    const updateRunModelFn = apiFn("UpdateRunModelFn", "update-run-model.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    runsTable.grantReadWriteData(updateRunModelFn);

    const securityDecisionFn = apiFn("SecurityDecisionFn", "security-decision.ts", {
      RUNS_TABLE: runsTable.tableName,
    });
    runsTable.grantReadWriteData(securityDecisionFn);
    stateMachine.grantTaskResponse(securityDecisionFn);

    repo.grantRead(repositoryReadFn);
    repositoryReadFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codecommit:ListBranches"],
        resources: [repo.repositoryArn],
      })
    );
    runsTable.grantReadData(repositoryReadFn);
    runsTable.grantReadWriteData(repositoryResetFn);
    repoControlTable.grantReadWriteData(repositoryResetFn);
    resetAuditTable.grantReadWriteData(repositoryResetFn);
    repositoryResetFn.addEnvironment("STATE_MACHINE_ARN", stateMachine.stateMachineArn);
    repositoryResetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["states:ListExecutions", "states:StopExecution"],
        resources: [stateMachine.stateMachineArn, `${stateMachine.stateMachineArn}:*`,
          `arn:aws:states:${this.region}:${this.account}:execution:*`],
      })
    );
    repositoryResetFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "codecommit:GetBranch",
          "codecommit:GetCommit",
          "codecommit:GetFolder",
          "codecommit:GetFile",
          "codecommit:CreateCommit",
        ],
        resources: [repo.repositoryArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["codecommit:GetBranch", "codecommit:DeleteBranch"],
        resources: [repo.repositoryArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:GetItem"],
        resources: [runsTable.tableArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:UpdateItem"],
        resources: [repoControlTable.tableArn],
      })
    );
    repositoryDeleteFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
        resources: [resetAuditTable.tableArn],
      })
    );
    contextApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [contextTable.tableArn],
      })
    );
    contextApiFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`${contextBucket.bucketArn}/users/*`],
      })
    );
    contextCleanupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "dynamodb:Scan",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:TransactWriteItems",
        ],
        resources: [contextTable.tableArn],
      })
    );
    contextCleanupFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:DeleteObject"],
        resources: [`${contextBucket.bucketArn}/users/*`],
      })
    );
    new events.Rule(this, "ContextCleanupSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [new eventsTargets.LambdaFunction(contextCleanupFn)],
    });
    getModelsFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock-agentcore:InvokeAgentRuntime"],
        resources: [
          agentRuntime.attrAgentRuntimeArn,
          `${agentRuntime.attrAgentRuntimeArn}/*`,
        ],
      })
    );

    const authorizer = new apigwv2Auth.HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] }
    );

    const httpApi = new apigwv2.HttpApi(this, "Api", {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        // PoC: CloudFront domain is unknown until deploy; tighten afterwards.
        allowOrigins: ["*"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: ["authorization", "content-type"],
        maxAge: cdk.Duration.hours(1),
      },
    });
    httpApi.addRoutes({
      path: "/models",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration("GetModelsInt", getModelsFn),
    });
    httpApi.addRoutes({
      path: "/decision-model/endpoint",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("DeciderEndpointInt", deciderEndpointFn),
    });
    httpApi.addRoutes({
      path: "/mcp/config",
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("McpConfigInt", mcpApiFn),
    });
    for (const [routePath, method, routeId] of [
      ["/context", apigwv2.HttpMethod.GET, "ContextListInt"],
      ["/context/notes", apigwv2.HttpMethod.POST, "ContextNotesInt"],
      ["/context/uploads", apigwv2.HttpMethod.POST, "ContextUploadsInt"],
      ["/context/{itemId}/complete", apigwv2.HttpMethod.POST, "ContextCompleteInt"],
      ["/context/{itemId}/preview", apigwv2.HttpMethod.GET, "ContextPreviewInt"],
      ["/context/{itemId}", apigwv2.HttpMethod.DELETE, "ContextDeleteInt"],
    ] as const) {
      httpApi.addRoutes({
        path: routePath,
        methods: [method],
        integration: new apigwv2Int.HttpLambdaIntegration(routeId, contextApiFn),
      });
    }
    for (const [routePath, routeId] of [
      ["/repository/refs", "RepositoryRefsInt"],
      ["/repository/tree", "RepositoryTreeInt"],
      ["/repository/file", "RepositoryFileInt"],
      ["/runs/{runId}/review", "RunReviewInt"],
    ] as const) {
      httpApi.addRoutes({
        path: routePath,
        methods: [apigwv2.HttpMethod.GET],
        integration: new apigwv2Int.HttpLambdaIntegration(routeId, repositoryReadFn),
      });
    }
    httpApi.addRoutes({
      path: "/repository/reset-status",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration(
        "RepositoryResetStatusInt",
        repositoryResetFn
      ),
    });
    httpApi.addRoutes({
      path: "/repository/reset",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration(
        "RepositoryResetInt",
        repositoryResetFn
      ),
    });
    httpApi.addRoutes({
      path: "/repository/fix-branches/{runId}",
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Int.HttpLambdaIntegration(
        "RepositoryDeleteFixBranchInt",
        repositoryDeleteFn
      ),
    });
    httpApi.addRoutes({
      path: "/runs",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("StartRunInt", startRunFn),
    });
    httpApi.addRoutes({
      path: "/runs",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration("ListRunsInt", getRunsFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}",
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Int.HttpLambdaIntegration("GetRunInt", getRunsFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}/decision",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("DecisionInt", decisionFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}/review-decision",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("ReviewDecisionInt", reviewDecisionFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}/model",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("UpdateRunModelInt", updateRunModelFn),
    });
    httpApi.addRoutes({
      path: "/runs/{runId}/security-decision",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Int.HttpLambdaIntegration("SecurityDecisionInt", securityDecisionFn),
    });

    // ------------------------------------------------------------------
    // UI hosting: private S3 + CloudFront (OAC)
    // ------------------------------------------------------------------
    const uiBucket = new s3.Bucket(this, "UiBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // PoC only
      autoDeleteObjects: true,
    });

    const distribution = new cloudfront.Distribution(this, "UiDistribution", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(uiBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      defaultRootObject: "index.html",
      errorResponses: [
        // SPA routing
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
    });

    // ------------------------------------------------------------------
    // Security review: AWS Security Agent agent space, service role and the CloudFront domain as
    // a target domain verified by HTTP route (the token is published by the UI deployment below).
    // ------------------------------------------------------------------
    const securityAgent = securityAgentEnabled
      ? new SecurityAgent(this, "SecurityAgent", { contextBucket, distribution })
      : undefined;
    if (securityAgent) {
      const agentSpaceArns = securityAgent.agentSpaceArns;
      for (const fn of [securityStartFn, securityCheckFn, repositoryResetFn]) {
        fn.addEnvironment("AGENT_SPACE_ID", securityAgent.agentSpaceId);
      }
      securityStartFn.addEnvironment("SERVICE_ROLE_ARN", securityAgent.serviceRole.roleArn);
      securityStartFn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "securityagent:CreateCodeReview",
          "securityagent:StartCodeReviewJob",
          "securityagent:CreatePentest",
          "securityagent:StartPentestJob",
        ],
        resources: agentSpaceArns,
      }));
      // Code reviews and pentests run as the agent space's service role.
      securityStartFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [securityAgent.serviceRole.roleArn],
      }));
      securityCheckFn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "securityagent:ListCodeReviewJobsForCodeReview",
          "securityagent:ListCodeReviewJobTasks",
          "securityagent:ListPentestJobsForPentest",
          "securityagent:ListPentestJobTasks",
          "securityagent:ListFindings",
        ],
        resources: agentSpaceArns,
      }));
      // Restore-buggy-state stops review jobs that are still running.
      repositoryResetFn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          "securityagent:ListPentests",
          "securityagent:ListPentestJobsForPentest",
          "securityagent:StopPentestJob",
          "securityagent:ListCodeReviews",
          "securityagent:ListCodeReviewJobsForCodeReview",
          "securityagent:StopCodeReviewJob",
        ],
        resources: agentSpaceArns,
      }));
    }
    for (const fn of [startRunFn, getModelsFn]) {
      fn.addEnvironment("SECURITY_AGENT_ENABLED", String(securityAgentEnabled));
    }

    const uiDeployment = new s3deploy.BucketDeployment(this, "UiDeployment", {
      destinationBucket: uiBucket,
      distribution,
      sources: [
        s3deploy.Source.asset(path.join(__dirname, "..", "..", "ui", "dist")),
        s3deploy.Source.jsonData("config.json", {
          apiUrl: httpApi.apiEndpoint,
          region: this.region,
          userPoolId: userPool.userPoolId,
          userPoolClientId: userPoolClient.userPoolClientId,
        }),
        // Proof of domain ownership for Security Agent; the token is not a secret.
        ...(securityAgent
          ? [s3deploy.Source.jsonData(SECURITY_AGENT_VERIFICATION_ROUTE, {
              tokens: [securityAgent.verificationToken],
            })]
          : []),
      ],
    });
    securityAgent?.verifyAfter(uiDeployment);

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, "UiUrl", { value: `https://${distribution.domainName}` });

    // Wire Security Review Lambda to the CloudFront endpoint
    securityStartFn.addEnvironment("APP_ENDPOINT", `https://${distribution.domainName}`);
    new cdk.CfnOutput(this, "ApiUrl", { value: httpApi.apiEndpoint });
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "RepoCloneUrlHttp", { value: repo.repositoryCloneUrlHttp });
    new cdk.CfnOutput(this, "AgentRuntimeArn", { value: agentRuntime.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, "StateMachineArn", { value: stateMachine.stateMachineArn });
    new cdk.CfnOutput(this, "KiroKeySecretArn", { value: kiroKeySecret.secretArn });
    // The CPU outputs keep their earlier names; the GPU ones are new.
    const cpuDecider = decider.variant("cpu");
    const gpuDecider = decider.variant("gpu");
    new cdk.CfnOutput(this, "DeciderEndpointName", {
      value: cpuDecider.endpointName,
      description: "CPU endpoint. Not deployed by cdk deploy; start and stop it from the Settings tab",
    });
    new cdk.CfnOutput(this, "DeciderEndpointConfigName", { value: cpuDecider.endpointConfigName });
    new cdk.CfnOutput(this, "DeciderInstanceType", { value: cpuDecider.instanceType });
    new cdk.CfnOutput(this, "DeciderGpuEndpointName", {
      value: gpuDecider.endpointName,
      description: "GPU endpoint. Not deployed by cdk deploy; start and stop it from the Settings tab",
    });
    new cdk.CfnOutput(this, "DeciderGpuEndpointConfigName", { value: gpuDecider.endpointConfigName });
    new cdk.CfnOutput(this, "DeciderGpuInstanceType", { value: gpuDecider.instanceType });
    new cdk.CfnOutput(this, "SettingsTableName", { value: settingsTable.tableName });
    new cdk.CfnOutput(this, "SecurityAgentEnabled", { value: String(securityAgentEnabled) });
    if (securityAgent) {
      new cdk.CfnOutput(this, "SecurityAgentSpaceId", { value: securityAgent.agentSpaceId });
      new cdk.CfnOutput(this, "SecurityAgentServiceRoleArn", { value: securityAgent.serviceRole.roleArn });
      new cdk.CfnOutput(this, "SecurityAgentTargetDomainId", { value: securityAgent.targetDomainId });
      new cdk.CfnOutput(this, "SecurityAgentDomainVerification", {
        value: securityAgent.verificationStatus ?? "UNKNOWN",
        description: "VERIFIED is required for penetration tests; code reviews work either way",
      });
    }
  }
}
