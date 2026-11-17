# Strands Decider inference image for the ADLC PoC SageMaker real-time endpoint
# (x86_64 CPU instances). Dockerfile.gpu is the GPU variant of the same server.
#
# The image holds the strands-decider server and its dependencies but no model weights.
# SageMaker copies the pinned checkpoint and its base model from the stack's private S3 bucket to
# /opt/ml/model before the container starts (infra/lib/decision-model.ts), and the server loads
# them with HF_HUB_OFFLINE=1. The SageMaker model runs with network isolation, so the container
# has no network access at all.
#
# Supply chain: the base image is pinned by digest (ECR Public mirror of the Docker official
# image, which also avoids Docker Hub pull limits in CodeBuild), and every Python package is pinned
# by version and SHA-256 in requirements.txt and installed with --require-hashes.
#
# SageMaker expects inference containers to run as root (AWS: "Custom Inference Code with Hosting
# Services"), so there is no USER line; isolation comes from network isolation and the
# least-privilege execution role.
#
# Adapted from strands-labs/strands-decider deploy/sagemaker/Dockerfile (Apache-2.0).
FROM public.ecr.aws/docker/library/python:3.11-slim-bookworm@sha256:94a8fee35252d06ab75856f15f12c7bae67b10e8a6da93c7fded82b2610926cd

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --no-deps --only-binary=:all: \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && pip check

COPY serve.py /opt/decider/serve.py

# Runtime settings. DECIDER_CHECKPOINT is set by the SageMaker model (it names the checkpoint
# folder under /opt/ml/model). DECIDER_HOST is the in-container bind: SageMaker reaches the
# container over its private network namespace, no port is published, and callers go through the
# SigV4-authorized InvokeEndpoint API.
ENV HF_HOME=/tmp/hf \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    DECIDER_DEVICE=cpu \
    DECIDER_HOST=0.0.0.0 \
    DECIDER_PORT=8080

EXPOSE 8080
ENTRYPOINT ["python", "/opt/decider/serve.py"]
