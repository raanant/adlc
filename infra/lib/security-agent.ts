import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import type * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";

/** Where the HTTP-route verification token is published on the UI distribution. */
export const SECURITY_AGENT_VERIFICATION_ROUTE =
  ".well-known/aws/securityagent-domain-verification.json";
/** Prefix of the context bucket where the start step uploads source archives for review. */
export const SECURITY_REVIEW_PREFIX = "security-review/";
const AGENT_SPACE_NAME = "adlc-poc";

export interface SecurityAgentProps {
  contextBucket: s3.IBucket;
  distribution: cloudfront.IDistribution;
}

/**
 * AWS Security Agent resources for the optional security review: the agent space, its service
 * role and a target domain for the CloudFront UI, verified by HTTP route. Enabled by default;
 * `cdk deploy -c securityAgent=false` leaves all of it out.
 *
 * Least privilege:
 * - The service role follows the console's base policy (AWS Security Agent user guide, "Create the
 *   IAM roles"), scoped to this space's name, plus read access to the review prefix of the context
 *   bucket only (never the users' private context files). Its trust policy allows only Security
 *   Agent, for agent spaces in this account and Region.
 * - The custom resource can read and verify only this target domain.
 */
export class SecurityAgent extends Construct {
  readonly agentSpaceId: string;
  /** IAM resource ARNs of the agent space. Security Agent reports both forms in its APIs. */
  readonly agentSpaceArns: string[];
  readonly serviceRole: iam.Role;
  readonly targetDomainId: string;
  readonly verificationToken: string;
  verificationStatus?: string;
  private readonly serviceToken: string;

  constructor(scope: Construct, id: string, props: SecurityAgentProps) {
    super(scope, id);
    const stack = cdk.Stack.of(this);
    const partition = cdk.Aws.PARTITION;
    const prefix = `arn:${partition}:securityagent:${stack.region}:${stack.account}`;

    this.serviceRole = new iam.Role(this, "ServiceRole", {
      path: "/service-role/",
      description: "AWS Security Agent service role of the adlc-poc agent space",
      assumedBy: new iam.ServicePrincipal("securityagent.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": stack.account },
          ArnLike: { "aws:SourceArn": `${prefix}:agent-space/*` },
        },
      }),
    });
    const role = this.serviceRole;
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["iam:GetRole", "iam:SimulatePrincipalPolicy"],
        resources: [role.roleArn],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [
          `arn:${partition}:secretsmanager:${stack.region}:${stack.account}:secret:${AGENT_SPACE_NAME}*`,
        ],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogGroup"],
        resources: [
          `arn:${partition}:logs:${stack.region}:${stack.account}:log-group:/aws/securityagent/${AGENT_SPACE_NAME}*`,
        ],
        conditions: { StringEquals: { "aws:ResourceAccount": stack.account } },
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
        resources: [
          `arn:${partition}:logs:${stack.region}:${stack.account}:log-group:/aws/securityagent/${AGENT_SPACE_NAME}*:log-stream:${AGENT_SPACE_NAME}*`,
        ],
        conditions: { StringEquals: { "aws:ResourceAccount": stack.account } },
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [props.contextBucket.arnForObjects(`${SECURITY_REVIEW_PREFIX}*`)],
      })
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [props.contextBucket.bucketArn],
        conditions: { StringLike: { "s3:prefix": [`${SECURITY_REVIEW_PREFIX}*`] } },
      })
    );

    const tags = [
      { Key: "project", Value: "adlc-poc" },
      { Key: "component", Value: "security-review" },
    ];
    const targetDomain = new cdk.CfnResource(this, "TargetDomain", {
      type: "AWS::SecurityAgent::TargetDomain",
      properties: {
        TargetDomainName: props.distribution.distributionDomainName,
        VerificationMethod: "HTTP_ROUTE",
        Tags: tags,
      },
    });
    this.targetDomainId = targetDomain.ref;

    const agentSpace = new cdk.CfnResource(this, "AgentSpace", {
      type: "AWS::SecurityAgent::AgentSpace",
      properties: {
        Name: AGENT_SPACE_NAME,
        Description: "ADLC PoC: code review and penetration test of each validated fix",
        AwsResources: {
          IamRoles: [role.roleArn],
          S3Buckets: [props.contextBucket.bucketArn],
        },
        TargetDomainIds: [targetDomain.ref],
        Tags: tags,
      },
    });
    // The role's permissions must exist before Security Agent validates the role.
    const rolePolicy = role.node.tryFindChild("DefaultPolicy");
    if (rolePolicy) agentSpace.node.addDependency(rolePolicy);
    this.agentSpaceId = agentSpace.ref;
    this.agentSpaceArns = [
      `${prefix}:agent-space/${agentSpace.ref}`,
      `${prefix}:agent-instance/${agentSpace.ref}`,
    ];

    const domainFn = new NodejsFunction(this, "DomainFn", {
      entry: path.join(__dirname, "..", "lambdas", "custom", "security-agent-domain.ts"),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(8),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { externalModules: [], minify: true, sourceMap: false },
    });
    domainFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["securityagent:BatchGetTargetDomains", "securityagent:VerifyTargetDomain"],
        resources: [`${prefix}:target-domain/${targetDomain.ref}`],
      })
    );
    const provider = new cr.Provider(this, "DomainProvider", {
      onEventHandler: domainFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    this.serviceToken = provider.serviceToken;

    const token = new cdk.CustomResource(this, "VerificationToken", {
      serviceToken: this.serviceToken,
      resourceType: "Custom::SecurityAgentDomainToken",
      properties: { Phase: "token", TargetDomainId: targetDomain.ref },
    });
    this.verificationToken = token.getAttString("Token");

    cdk.Tags.of(this).add("project", "adlc-poc");
  }

  /** Verify the domain once `publication` (the UI deployment carrying the token) is done. */
  verifyAfter(publication: Construct): void {
    const verification = new cdk.CustomResource(this, "DomainVerification", {
      serviceToken: this.serviceToken,
      resourceType: "Custom::SecurityAgentDomainVerification",
      properties: {
        Phase: "verify",
        TargetDomainId: this.targetDomainId,
        Token: this.verificationToken,
      },
    });
    verification.node.addDependency(publication);
    this.verificationStatus = verification.getAttString("Status");
  }
}
