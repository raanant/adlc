# ADLC Bug-Fix PoC

A proof of concept for an **agentic development lifecycle (ADLC)** on AWS: paste a
bug report, let AI triage it and draft a fix plan, approve it at a human gate (or
auto-approve simple cases), have the **Kiro CLI** coding agent implement the fix in
an isolated **Bedrock AgentCore** container, validate the result independently, and
get a fully audited report with cost and resource usage.

## Features

- **End-to-end pipeline** — triage → dual artifact draft (Simple prompt / Complex
  spec) → human approval gate → Kiro implementation → independent validation →
  bounded fix loop (max 3 attempts) → human review gate when the loop cannot finish →
  report. Orchestrated by AWS Step Functions.
- **Frozen artifacts** — the prompt or spec you approve is executed byte-for-byte
  on every automatic attempt; only a reviewer at the review gate can replace it, as a
  new recorded version.
- **Independent verification** — a build gate (`npm install && npm run build`) compared
  with the commit the run started from, plus a separate validator model reviewing the diff
  against the frozen artifact. The agent's own summary is displayed as a claim, not evidence.
- **Human-in-the-loop controls** — editable artifacts at the gate, execute/cancel,
  optional auto-execute for SIMPLE triage verdicts (COMPLEX always pauses), and a review
  gate after failed attempts: accept with a reason, retry with guidance, or close.
- **MCP support** — a JSON editor for Model Context Protocol servers; the config is
  snapshotted per run, written to `.kiro/settings/mcp.json` for Kiro inside the
  container, never committed, and every MCP tool call is logged.
- **Context library** — private notes, PDFs, and images that inform triage
  (multimodal Bedrock analysis).
- **Full cost & usage accounting** — analysis model tokens, Kiro credits (parsed
  from Kiro's structured stream output), in-container CPU / peak-memory
  sampling via cgroup v2, and Security Agent pentest task-hours ($50/hr), per run.
- **AWS Security Agent integration** — optional code review + penetration test
  (DAST) after validation via AWS Security Agent (Continuum). Three modes:
  Skip, Scan only (async, fire-and-forget), or Scan & remediate (polls until
  complete, collects findings). Pentest cost is calculated from actual task-hours
  fetched from the Security Agent API.
- **Decision model second opinion (optional)** — a per-run option that also asks
  [Strands Decider](https://github.com/strands-labs/strands-decider), a small decision model,
  to answer five yes/no checks about the bug report, from which a SIMPLE or COMPLEX verdict and
  its likelihood follow. The result is shown next to the LLM triage (agrees/disagrees), with each
  check, an explanation and the exact prompt, and never changes routing. It runs
  on a private SageMaker endpoint, CPU or GPU, that is off by default; the ⚙ Settings tab starts
  and stops both and picks the one the pipeline uses. See [Decision model](#decision-model-optional).
- **Read-only repository explorer** — before/after fix review with verification
  evidence, seeded-bug jump cards, guarded restore of the canonical buggy state,
  and guarded fix-branch deletion (`main` is structurally protected).
- **In-app user guide** — the 📖 button in the header.

## Architecture

```
React SPA (CloudFront + S3, Cognito auth)
        │
        ▼
API Gateway (HTTP API, JWT authorizer) ── Lambdas: runs, decision, models,
        │                                  repository, context, mcp
        ▼
Step Functions state machine
  TRIAGE ─ [DECISION MODEL] ─ DRAFT ─ (auto-)GATE ─ IMPLEMENT ─ VALIDATE ─ SECURITY ─┐
     ▲            │                                    │                    │        │ fail (≤3)
     │            ▼                                    ▼                    ▼        ▼
  Bedrock   SageMaker endpoint                  Bedrock AgentCore    AWS Security Agent
  (analysis (Strands Decider, optional,               │              (code review + pentest)
   models)   informative only)                        ▼
                                              CodeCommit repo (fix/<run-id> branches)
```

Storage: DynamoDB (runs, context items + MCP config, repo control, reset audit),
S3 (context files, UI assets), Secrets Manager (Kiro API key).

## Repository structure

| Path | Contents |
|------|----------|
| `infra/` | AWS CDK app (single stack `AdlcPocStack`) and all Lambda sources |
| `agent/` | AgentCore container: `Dockerfile` and `app.py` (Kiro CLI harness) |
| `ui/` | React + Vite single-page application |
| `decider/` | Optional decision model: SageMaker inference image and the pinned model-fetch script ([decider/README.md](decider/README.md)) |
| `dummy-app/` | The seeded target repository (todo-service with BUG-001/BUG-002) |
| `docs/` | Design documents (todo-service design doc in Markdown and PDF) |

## Prerequisites

- An AWS account with **Bedrock model access** enabled for Anthropic Claude models
  (used for triage, drafting, and validation) in your deployment region
- A **Kiro subscription** and API key (`ksk_…`) from [kiro.dev](https://kiro.dev)
- Node.js ≥ 18 and npm
- Docker (the agent container image is built locally during deploy)
- AWS CLI configured, and the target account **CDK-bootstrapped**
  (`npx cdk bootstrap`)

## Deployment

```bash
# 1. Build the UI (its dist/ is deployed by the stack)
cd ui
npm install
npm run build

# 2. Deploy the stack
cd ../infra
npm install
npx cdk deploy AdlcPocStack --require-approval never
```

The coding agent runs on AgentCore Runtime **platform V2** (`PlatformVersion: V2` on the
`CodingAgentRuntime` resource in `infra/lib/adlc-poc-stack.ts`). A V2 session starts by restoring
a snapshot taken after the container's start-up, so cold starts stay short whatever the image
size, and memory is billed by use. `agent/app.py` does only imports and constants at start-up;
everything that must differ per request (AWS clients, credentials, temp directories, timestamps,
Kiro CLI processes) happens in the request handler, as V2 requires. Keep it that way when
editing `app.py`. To go back to V1, set the override to `"V1"` and redeploy. Measured on
2026-11-03 (runtime version 12): the platform start of a new session took 2.1–2.6 s; listing
Kiro models in a new session then took another 6.5–26 s, which is Kiro CLI's own work.

The stack outputs the CloudFront URL, API endpoint, Cognito pool/client IDs, the
state machine ARN, the AgentCore runtime ARN, the Kiro key secret ARN, the
decision-model endpoint name and configuration, and the Security Agent space,
service role and domain verification status. Security Agent is provisioned by
default; add `-c securityAgent=false` to leave it out (see
[Security Agent integration](#security-agent-integration)). The target repository is created
and seeded automatically from `dummy-app/`. The deploy also fetches the decision
model's weights (about 25 GB) and builds its CPU and GPU images in CodeBuild, but
does not start either billed endpoint.

### Post-deploy setup

1. **Kiro API key** (required — there is no fallback engine):

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id adlc-poc/kiro-api-key \
     --secret-string ksk_YOUR_KEY_HERE
   ```

2. **Create a user** (self-signup is disabled):

   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId output> \
     --username you@example.com \
     --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
     --temporary-password 'ChooseATempPassword1!' \
     --message-action SUPPRESS

   # Optional: allow this user to restore the canonical buggy repo state
   aws cognito-idp admin-add-user-to-group \
     --user-pool-id <UserPoolId output> \
     --username you@example.com \
     --group-name repo-resetters
   ```

3. Open the **UiUrl** output, sign in (you will be asked to set a permanent
   password), and check that the "Implementation model" dropdown lists Kiro
   models — that proves the agent container and key work end to end.

## Usage

1. On the **Workflow** tab, load a seeded bug preset (or paste your own bug
   report), pick an analysis model, optionally enable context / auto-execute,
   and start the run.
2. Watch the pipeline timeline and live agent logs.
3. At the gate, review and optionally edit the Simple prompt or Complex spec,
   then execute.
4. Read the report: verification panel, usage breakdown, validation checks.
5. Click **Inspect fix** to see the before/after diff with evidence, or use the
   **Repository** tab directly.
6. Use **Restore buggy state** to reset the demo between sessions.

The in-app 📖 **User guide** covers every screen and field in detail.

## Costs

Each run consumes Bedrock tokens (analysis), Kiro credits (implementation), and
AgentCore compute — all reported per run in the UI. The idle stack costs are the
usual serverless baseline (DynamoDB on-demand, S3, CloudFront, Secrets Manager).

| Component | Typical cost | Notes |
|-----------|-------------|-------|
| Analysis (Haiku 5.5) | under $0.01 | Triage + draft calls |
| Analysis (Sonnet 5.5) | $0.01 – $0.07 | Triage + draft calls |
| Analysis (Opus 5.5) | $0.01 – $0.14 | Triage + draft calls |
| Kiro CLI | $0.50 – $3.00 | Per implementation attempt |
| AgentCore runtime | Small | Container compute on platform V2: CPU while active, memory by use |
| Code review | **Free** | Static analysis, 15–30 min |
| Pentest | **$250 – $400** | $50/task-hour × 5–8 hours typical |
| Decision model, CPU endpoint | **$0.922 / hour** while running | ml.m5.4xlarge in us-east-1 (about $22/day); no per-run charge; **not running by default**, started and stopped in ⚙ Settings |
| Decision model, GPU endpoint | **$2.605 / hour** while running | ml.g6e.xlarge in us-east-1 (about $63/day); same terms as the CPU endpoint |

Without security review, a typical run costs **under $5**. With pentest enabled,
the security review dominates the cost.

Delete the stack with `npx cdk destroy AdlcPocStack` when done. It also deletes the
decision-model endpoints if they are running.

## Decision model (optional)

The triage step's SIMPLE/COMPLEX verdict comes from an LLM. A run can also ask a **decision
model** for an independent answer. A decision model (a "System One" model, a class popularised by
TypeSafe AI's Jev) does not generate text: it scores the fixed options of a typed question in
one forward pass and returns a calibrated probability for each. This project uses
[Strands Decider](https://github.com/strands-labs/strands-decider)
`strands-decider-12B-gemma4-v1-2610` (Apache-2.0), the largest released checkpoint.

**What it does.** With "Decision model second opinion" checked, a `DecisionModel` step runs
right after triage. It sends only the bug report (never the code or the LLM verdict) with five
yes/no checks, one per condition of the default triage guidance: new dependency, data-model
change, API contract change, new component, and "a small edit in fewer than 5 files"
(`DECIDER_CHECKS` in `infra/lambdas/shared/decider.ts`). The verdict follows from the checks:

- **SIMPLE** when every check passes. Its likelihood is the least sure passing check.
- **COMPLEX** when any check fails. Its likelihood is the most sure failing check.
- **Certainty** is HIGH at 95% or more, MEDIUM from 75% to 95%, and LOW below 75%.

The run page shows the verdict, its likelihood, each check with how sure the model is, the check
that decided the verdict, and whether it agrees with the LLM. It also has a "How the decision
model works" panel and a "Show the prompt the model read" panel with the exact text of each
prompt and the JSON request. The execution gate repeats the verdict and any failing checks. The
step is **informative only**: `AutoExecuteSimple?` and the gate recommendation still read the LLM
triage, and every decision-model outcome (stopped, not ready, error, timeout, invalid answer) is
recorded and the run continues. Custom triage guidance on the start form changes the LLM's
instructions only; the decision model keeps asking the five checks.

**CPU and GPU endpoints.** The same model can run on two endpoints:

| Endpoint | Instance (default) | Price in us-east-1 | Answer time |
|----------|--------------------|--------------------|-------------|
| `adlc-poc-decider` (CPU) | `ml.m5.4xlarge`, fp32 | $0.922 / hour | about 19 s for a short report; long reports can pass the 60 s limit |
| `adlc-poc-decider-gpu` (GPU) | `ml.g6e.xlarge`, one NVIDIA L40S, bf16 | $2.605 / hour | expected to be a few seconds; not measured yet (see below) |

Both can be running at the same time, but a run uses only one: the ⚙ **Settings** tab picks
**which endpoint the pipeline uses** (CPU by default). The choice is stored in the settings table;
`start-run` records it on each new run, so changing it never switches a run that has already
started. The run page shows which endpoint answered.

**Deploy, start, stop.** Everything is in `AdlcPocStack`: a plain `cdk deploy` creates the
pinned weights (copied once by CodeBuild from Hugging Face into a private bucket and shared by
both endpoints), and for each endpoint an inference image, a SageMaker model and an endpoint
configuration. **It does not create the endpoints**, so nothing is billed by the hour until someone
starts one. For each endpoint, Settings shows the status, instance type, hourly price, running time
and estimated cost so far, and has two buttons:

- **Deploy** creates the endpoint from its endpoint configuration (after a cost confirmation).
  The run-form option becomes available once the endpoint the pipeline uses is InService.
- **Stop (delete)** deletes it and ends the billing; the configuration and weights stay, so it
  can be deployed again.

Settings warns when the endpoint the pipeline uses is not running, and when the other one is
running and billed without being used. Any signed-in user can see the status, use Deploy and Stop,
and change which endpoint the pipeline uses. Each action is written to the audit table with the
caller's identity before SageMaker or the setting is changed. If a later `cdk deploy` replaces an
endpoint configuration, a running endpoint keeps the old one and Settings says so (stop and
deploy again). `cdk destroy` deletes both endpoints before the rest of the stack.

The instance types are CDK context values, `-c deciderInstanceType=ml.r7i.4xlarge` (CPU: x86,
≥ 64 GiB, because the 12B model runs in fp32 on CPU, about 48 GB) and
`-c deciderGpuInstanceType=ml.g6e.2xlarge` (GPU: L40S 48 GB types; the 24 GB A10G and L4 types are
too small for the model in bf16). The allowed types are listed in `infra/lib/decider-config.ts`.
The GPU endpoint runs on SageMaker's `al2023-ami-sagemaker-inference-gpu-4-1` host image (NVIDIA
driver 580); its container uses the CUDA 12.6 build of torch.

**Security.**

- Only the `DecisionModelFn` step can call the endpoints (`sagemaker:InvokeEndpoint` on the two
  endpoint ARNs, plus `dynamodb:UpdateItem` on the runs table and nothing else). A run names a
  variant (`cpu` or `gpu`), never an endpoint name; the step maps it to an endpoint from its own
  configuration. The containers have no authentication of their own and are reachable only
  through SigV4-signed InvokeEndpoint calls.
- The Settings Lambda can describe and delete the two endpoints, create them only from the two
  stack-owned endpoint configurations (`sagemaker:CreateEndpoint` on those ARNs), read and write
  the one settings item, and write the audit table. The `/models` Lambda can only describe the
  endpoints and read the setting; `start-run` can only read the setting. Deploy, Stop and the
  endpoint choice are refused on the server for any request without a verified Cognito identity.
- The SageMaker models run with network isolation. Each endpoint has its own execution role,
  which can read only the model's S3 prefix, pull only its own image and write only its own log
  group; the trust policies are limited to SageMaker in this account and Region.
- Weights are pinned to Hugging Face commit SHAs and verified against the checkpoint's SHA-256
  manifest. The base image is pinned by digest and every Python package by hash
  ([decider/README.md](decider/README.md)).

**Accuracy.** Measured on the 21 hand-labelled bug reports in `decider/eval/cases.json` with the
shipped request ([decider/README.md](decider/README.md#evaluation)), the 12B model answered 21 of
21 correctly (5 with HIGH certainty, 13 MEDIUM, 3 LOW); the 2B model answered 17 of 21. Treat a
disagreement as a prompt to read the artifact more carefully, not as a verdict.

**Latency.** On the CPU endpoint (`ml.m5.4xlarge`) an answer takes about 19 s for a short bug
report and about 43 s at 2,600 characters. Reports of roughly 3,500 characters or more can exceed
SageMaker's 60-second invocation limit; the step then records a failed second opinion and the run
continues. The GPU endpoint has not been measured yet: on 2026-11-02 SageMaker could not start an
`ml.g6e.xlarge` in us-east-1 twice (`InsufficientInstanceCapacity`), so its timing is unverified.
If a GPU deploy fails that way, Settings shows the reason; stop (delete) the failed endpoint and
deploy again later. The step runs between triage and drafting, so it adds this time to runs that
enable it.

## Build gate and review gate

**Build gate.** On a run's first implementation attempt the coding agent builds the commit
the run started from, in a separate worktree, before Kiro edits anything
(`baseline_build` in `agent/app.py`). It records the normalized TypeScript error lines
(file and message, without line and column). A fix passes the build gate when its build
succeeds, or when the base commit already failed and the fix adds no error the base did not
have (`infra/lambdas/shared/build-gate.ts`). Kiro is told which errors are pre-existing, and
the run page lists them. So a BUG-002 run passes even though BUG-001 still breaks `main`.
The validator model reviews the diff even when the build gate fails.

**Fix loop.** Up to 3 automatic attempts. The loop stops early when another attempt cannot
change the outcome: the same build errors as the previous attempt, or two attempts in a row
with no changes. If Kiro finds the fix already on the branch from an earlier attempt, the
branch is rebuilt and validated again instead of counting as a failure.

**Review gate.** When the loop cannot finish, the run waits in `AWAITING_REVIEW`
(`AwaitReview` state, `infra/lambdas/steps/await-review.ts`). The run page shows the build
comparison, the validator checks, the last attempt and a link to the diff. Any signed-in user
decides through `POST /runs/{runId}/review-decision` (`infra/lambdas/api/review-decision.ts`):

| Decision | Effect | Run ends as |
|----------|--------|-------------|
| Accept (reason required) | The fix branch continues to security review if the run asked for one | `ACCEPTED_BY_REVIEWER`, with reviewer, reason and failed checks; never a green validation |
| Retry with guidance | Guidance is added to Kiro's prompt; 1–3 more attempts; optional edit of the approved artifact, saved as a new version | (continues) |
| Close | The fix branch is kept | `NEEDS_HUMAN` |

A decision is claimed with a conditional write on the run, so only one reviewer can decide.
A run gets at most 9 attempts and 3 review rounds; the third round offers only Accept and
Close. With no decision within 7 days the run closes on its own (state machine timeout:
23 days). Repository reset and fix-branch delete are blocked while a run waits for review.

## Security Agent integration

The pipeline optionally integrates **AWS Security Agent** (Continuum) for automated
security scanning after validation passes. The start-run form offers three modes:

| Mode | Behavior |
|------|----------|
| **Skip** | No security review; pipeline goes straight to report |
| **Scan only** (default) | Kicks off code review + pentest asynchronously; run completes immediately |
| **Scan & remediate** | Polls until both complete (up to 60 min); findings shown in run report |

### Provisioning

`cdk deploy` provisions everything Security Agent needs, by default:

- an **agent space** named `adlc-poc` (`AWS::SecurityAgent::AgentSpace`);
- its **service role** (under `/service-role/`), with the permissions the Security Agent
  console's base policy grants, scoped to this space, plus read access to the
  `security-review/` prefix of the context bucket only. Its trust policy allows only
  Security Agent, for agent spaces in this account and Region;
- the CloudFront UI domain as a **target domain** (`AWS::SecurityAgent::TargetDomain`),
  verified by HTTP route: the deployment publishes the verification token at
  `/.well-known/aws/securityagent-domain-verification.json` on the distribution and then asks
  Security Agent to verify it. The `SecurityAgentDomainVerification` stack output shows the
  result. Pentests need `VERIFIED`; code reviews work either way.

The step Lambdas get only the Security Agent actions they call, on this agent space.

To leave all of it out:

```bash
npx cdk deploy AdlcPocStack -c securityAgent=false
```

The run form then disables the security-review selector, and the API records any run as
`skip` (with a warning in the run log). Deploying again without the flag provisions it.

### What runs

- **Code review** — static analysis (~15 tasks, 15–30 min). **Free.**
- **Penetration test** — dynamic DAST scanning (~30–50 tasks, 20–40 min).
  Billed at **$50 per task-hour**. Cost is calculated from actual `taskHours`
  returned by the `ListPentestJobTasks` API after completion.

### Security review card

When a pentest completes, the run page shows a security card with findings by
severity (Critical/High/Medium/Low) and a pass/fail verdict. The run passes
security review only if there are zero Critical and zero High findings.

### Cost tracking

Pentest cost appears in the usage breakdown as a dedicated "Security review" card
showing total task-hours, the $50/hr rate, and computed cost.

## Security notes

This is a proof of concept, not a production system:

- API CORS is permissive (`*`) until tightened post-deploy.
- MCP servers configured by users run inside the agent container with the same
  trust as the coding agent — add only servers you trust.
- The Kiro key secret and Cognito resources use `RemovalPolicy.DESTROY`.
- The agent can only push `fix/*` branches; `main` is protected structurally and
  reset/delete operations require group membership plus typed confirmations.
- The optional decision-model endpoints (CPU and GPU) are IAM-only and network-isolated. Any
  signed-in user can start or stop them and pick the one the pipeline uses from Settings, and
  each action is audited; see
  [Decision model](#decision-model-optional).

## License

MIT — see [LICENSE](LICENSE).
