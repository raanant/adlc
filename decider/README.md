# Decision model (Strands Decider)

The optional second opinion on SIMPLE/COMPLEX triage, served from a private Amazon SageMaker
real-time endpoint. The same model has two endpoints (`infra/lib/decider-config.ts`):

| Variant | Endpoint | Default instance | Image | Precision |
|---------|----------|------------------|-------|-----------|
| CPU | `adlc-poc-decider` | `ml.m5.4xlarge` | `image/Dockerfile`, CPU build of torch | fp32 (about 48 GB of memory) |
| GPU | `adlc-poc-decider-gpu` | `ml.g6e.xlarge` (NVIDIA L40S, 48 GB) | `image/Dockerfile.gpu`, CUDA 12.6 build of torch | bf16 (about 24 GB of GPU memory) |

`AdlcPocStack` (`infra/lib/decision-model.ts`) creates everything the endpoints need: the private
weights bucket (shared), and per variant an inference image, an execution role, a log group, a
SageMaker model and an endpoint configuration. It does **not** create the endpoints, which are
billed per hour. The ⚙ Settings tab deploys each from its configuration, stops (deletes) it, and
picks the variant the pipeline uses (`infra/lambdas/api/decider-endpoint.ts`; the choice is one
item in the stack's settings table, CPU when unset). `start-run` records the choice on each run and
the step maps it to an endpoint name (`infra/lambdas/shared/decider-variants.ts`), so a run uses
one endpoint only. A custom resource deletes both endpoints when the stack is deleted.

**GPU status (2026-11-02).** The GPU image builds and its packages check out (`pip check`; torch
`2.7.1+cu126` imports), but the endpoint has not served yet: two starts of `ml.g6e.xlarge` in
us-east-1 ended in `InsufficientInstanceCapacity` after about 35 minutes each. Its accuracy and
latency are therefore unmeasured. SageMaker's instance pools (`InstancePools`: fall back to another
instance type when one has no capacity) would help; CloudFormation supports them, but CDK 2.220's
typed props do not, so they would need a property override. That is not done.

The GPU endpoint runs on SageMaker's `al2023-ami-sagemaker-inference-gpu-4-1` host image (NVIDIA
driver 580, CUDA 13.0). A newer driver runs the image's CUDA 12.6 libraries, which torch ships as
pip packages, so the image needs no CUDA base image. The GPU configuration sets no EBS volume
size: these instance types come with a local NVMe disk (250 GB on `ml.g6e.xlarge`).

The model is [Strands Decider](https://github.com/strands-labs/strands-decider), a small
"System One" decision model (Apache-2.0). A decision model does not generate text. It reads a
state, scores the fixed options of a typed question, and returns a calibrated probability for
each option. Its answer is recorded on the run and shown in the UI. Routing never reads it.

| Path | Contents |
|------|----------|
| `image/` | Inference containers: `Dockerfile` (CPU) and `Dockerfile.gpu` (GPU), the shared `serve.py`, hash-locked `requirements.txt` / `requirements-gpu.txt` and their sources in `lock/` |
| `model-fetch/` | `fetch-model.ts`, which CodeBuild runs during `cdk deploy` to copy the pinned weights into the stack's private bucket |

## What is pinned

- **Weights**: `StrandsAgents/strands-decider-12B-gemma4-v1-2610` at commit `1202634…` (a LoRA
  adapter and readout head, 0.84 GB) and its base `google/gemma-4-12B-it` at commit `707f0a3…`
  (23.9 GB), both Apache-2.0 and not gated (`infra/lib/decider-config.ts`).
  `fetch-model.ts` refuses anything but full commit SHAs. It checks every checkpoint file
  against the checkpoint's `MANIFEST.sha256`, and refuses a base revision that differs from the
  one the checkpoint's `provenance.json` records.
- **Images**: `python:3.11-slim-bookworm` by digest (ECR Public mirror), and every Python package
  by version and SHA-256 (`pip install --require-hashes`), including `strands-decider==0.2.0`.
  The CPU image has 50 packages with the CPU build of `torch==2.7.1`. The GPU image has the same
  versions of every shared package (`lock/gpu/constraints.txt`, taken from `requirements.txt`) plus
  `torch==2.7.1+cu126`, `triton` and the NVIDIA CUDA 12.6 libraries, 66 packages in all.
- **Fetch tooling**: `@huggingface/hub` and `tsx` at exact versions, installed with `npm ci` from
  the committed lockfile.

strands-decider 0.2.0 serves `/health` and `/v1/systemone`. SageMaker calls `/ping` and
`/invocations`, so `serve.py` registers the package's own handlers under those paths too.

## Endpoint configuration naming

Each endpoint configuration has a fixed, lowercase name with a content hash,
`<endpoint name>-<12 hex>`. The hash covers that variant's Dockerfile, lock file and `serve.py`,
the pinned model, the device, the instance type, the volume size, the host image and the timeouts. A fixed name lets IAM scope `CreateEndpoint` to exactly this configuration
(SageMaker ARNs use lowercase names). The hash changes the name whenever the configuration is
replaced, which CloudFormation requires for a custom-named resource. A running endpoint keeps the
configuration it was created from; Settings flags it as out of date until it is stopped and
deployed again.

## Request design

The state is the bug report alone (`<bug-report>` inside the state block, shortened to 8,000
characters if needed). The code, the run's triage guidance and the LLM verdict are never sent, so
the answer is independent of the LLM's.

The Lambda asks five `noul` (true/false) questions in one request, one per condition of the
default triage guidance (`DECIDER_CHECKS` in `infra/lambdas/shared/decider.ts`):

| Check | Question (abridged) | Keeps the fix SIMPLE when |
|-------|---------------------|---------------------------|
| `new_dependency` | Does it require a library, SDK or external service the project does not use yet? | false |
| `data_model_change` | Does it require storing a new kind of data or changing how data is stored? | false |
| `contract_change` | Would existing API clients or services have to change their own code? | false |
| `new_component` | Does it require building something new, such as a cache, queue, job or login system? | false |
| `small_scope` | Is it a small, local edit to existing code, in fewer than 5 files? | true |

`deciderVerdict` turns the answers into a verdict. SIMPLE needs every check to pass and is as
likely as the least sure pass. One failing check makes it COMPLEX, as likely as the most sure
failure. The UI highlights that deciding check. Certainty is HIGH at 95% or more, MEDIUM from 75%
to 95%, LOW below 75%; these are the upstream routing bands (confidence 2p − 1 ≥ 0.9 and ≥ 0.5)
expressed as the verdict's probability.

Each check is rendered as strands-decider renders it: the shared state block, then the question
with its two numbered options, then `<answer>`. The run record keeps that text and the request
JSON (`deciderPromptRecord`) so the UI can show the exact prompt. The TypeScript renderer
(`renderDeciderPrompt`) matched `strands_decider.prompting.build_prompt` on 15 of 15 prompts.

Narrow checks replaced one broad `choice` question ("SIMPLE or COMPLEX?" with the triage
guidance as the instruction). The broad question gave the right label on 12 hand-written cases,
but only 51% and 65% likely on the two seeded bugs, which made the result hard to trust or
explain. Other variants tried on the 2B model with the 21 cases below: the five checks plus an
"overall" check (12/21), four checks without the size check, and a first wording of the five
checks (16/21). In earlier tests, adding the repository file list or source excerpts to the state
pushed the model toward COMPLEX, so the state stays the bug report alone.

## Evaluation

`eval/cases.json` holds 21 hand-labelled bug reports (SIMPLE and COMPLEX, including the two
seeded bugs). `eval/evaluate.ts` sends each through the production request, parsing and verdict
code and prints the verdict, likelihood, certainty and per-check scores:

```bash
cd decider/eval     # needs `npm ci` in infra/ and decider/model-fetch/
# Local server (see "Running it locally"):
DECIDER_URL=http://127.0.0.1:8080/invocations ../model-fetch/node_modules/.bin/tsx evaluate.ts
# The deployed endpoint (AWS credentials with sagemaker:InvokeEndpoint):
DECIDER_ENDPOINT=adlc-poc-decider ../model-fetch/node_modules/.bin/tsx evaluate.ts
```

| Model | Hardware | Correct | Round trip (median / max) |
|-------|----------|---------|---------------------------|
| 2B (`strands-decider-2B-qwen3.5-v1-2610`) | Apple M3 Pro, MPS | 17 / 21 | 1.15 s / — |
| 12B (`strands-decider-12B-gemma4-v1-2610`, shipped) | `ml.m5.4xlarge`, CPU fp32 | 21 / 21 | 18.6 s / 22.5 s |

With the 12B model, 5 answers had HIGH certainty, 13 MEDIUM and 3 LOW, and all 21 were right. The
two seeded bugs came out SIMPLE, 85% and 86% likely; the 2B model gave 64% SIMPLE and a wrong
COMPLEX (51%). Twenty-one cases is a small sample. Treat the result as a hint and measure it on
your own bugs.

**Latency on CPU (measured 2026-11-02, `ml.m5.4xlarge`).** Time grows with the length of the bug
report:

| Bug report | Input tokens | Time on the endpoint |
|------------|--------------|----------------------|
| about 600 characters (the eval cases) | about 600 | 18.6 s median |
| 950 characters | 809 | 24.7 s |
| 2,000 characters | 1,209 | 36.6 s |
| 2,600 characters | 1,449 | 43.3 s |
| 3,400 characters | 1,769 | 55.9 s |
| 5,000 characters or more | — | over SageMaker's 60 s invocation limit |

A request that runs past 60 s is recorded on the run as a failed second opinion and the run
continues with the LLM triage. The container serves one request at a time, so two runs asking at
once wait for each other. Memory use was 80% of the instance's 64 GiB, and CPU use about 780% of
1,600% while answering.

## Updating

- **Python dependencies**: edit `image/lock/pyproject.toml`, then regenerate `requirements.txt`
  with the command in its header. Then refresh `image/lock/gpu/constraints.txt` from it and
  regenerate `requirements-gpu.txt` (commands in their headers), so both images keep the same
  versions.
- **Model**: change `DECIDER_MODEL` in `infra/lib/decider-config.ts` (both revisions must be
  commit SHAs) and run `cdk deploy`. Then stop and deploy each endpoint in Settings that was
  running.

## Running it locally

```bash
python3.11 -m venv .venv && .venv/bin/pip install torch==2.7.1 transformers==5.19.0 strands-decider==0.2.0
(cd model-fetch && npm ci && DECIDER_BASE_DIR=/tmp/decider/model/base \
  npx tsx fetch-model.ts StrandsAgents/strands-decider-12B-gemma4-v1-2610 \
  1202634aec54c890c3e11b8747db62195f116006 707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7 /tmp/decider/model)
HF_HUB_OFFLINE=1 DECIDER_CHECKPOINT=/tmp/decider/model/strands-decider-12B-gemma4-v1-2610 \
  DECIDER_DEVICE=mps .venv/bin/python image/serve.py     # binds 127.0.0.1:8080; cpu on Linux
```

The 12B download is about 25 GB and needs about 48 GB of memory on CPU (fp32). For a quicker local
check, the same commands work with `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`
`216d1ccb46a9e9b036eb9187b248db98480f77d4` `b1485b2fa6dfa1287294f269f5fb618e03d52d7c`.

Adapted from strands-labs/strands-decider `deploy/sagemaker` (Apache-2.0).
