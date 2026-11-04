"""SageMaker entrypoint for the Strands Decider System One server.

strands-decider 0.2.0 serves ``GET /health`` and ``POST /v1/systemone``. A SageMaker real-time
endpoint calls ``GET /ping`` and ``POST /invocations`` instead, so this module builds the package's
own FastAPI app and registers the same two handlers under those paths as well. Nothing else about
the server changes: request validation, answers and errors are the package's.

The model is loaded from local files only (``HF_HUB_OFFLINE=1``): SageMaker copies the pinned
checkpoint and base model from S3 to ``/opt/ml/model`` before the container starts, and the
endpoint runs with network isolation.

Environment:
    DECIDER_CHECKPOINT  checkpoint directory (required)
    DECIDER_DEVICE      torch device, default ``cpu``
    DECIDER_HOST        bind address, default ``127.0.0.1``. The image sets ``0.0.0.0`` because
                        SageMaker reaches the container over its private network namespace; no
                        port is published, and InvokeEndpoint is SigV4/IAM-authorized.
    DECIDER_PORT        default 8080, the port SageMaker calls
    DECIDER_MAX_BATCH   questions per forward pass, default 8
"""

from __future__ import annotations

import os
import sys

import uvicorn
from fastapi.routing import APIRoute
from strands_decider.schema import SystemOneResponse
from strands_decider.server import create_app


def _env_int(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    value = int(raw)
    if not low <= value <= high:
        raise ValueError(f"{name} must be between {low} and {high}")
    return value


def build_app():  # type: ignore[no-untyped-def]
    checkpoint = os.environ.get("DECIDER_CHECKPOINT", "").strip()
    if not checkpoint or not os.path.isdir(checkpoint):
        raise SystemExit(f"DECIDER_CHECKPOINT is not a directory: {checkpoint!r}")
    if os.environ.get("HF_HUB_OFFLINE") != "1":
        raise SystemExit("HF_HUB_OFFLINE must be 1: the endpoint loads local files only")

    app = create_app(
        checkpoint,
        device=os.environ.get("DECIDER_DEVICE", "cpu").strip() or "cpu",
        max_batch=_env_int("DECIDER_MAX_BATCH", 8, 1, 32),
    )
    routes = {
        (route.path, method): route
        for route in app.routes
        if isinstance(route, APIRoute)
        for method in route.methods
    }
    health = routes[("/health", "GET")]
    systemone = routes[("/v1/systemone", "POST")]
    app.add_api_route("/ping", health.endpoint, methods=["GET"])
    app.add_api_route(
        "/invocations",
        systemone.endpoint,
        methods=["POST"],
        response_model=SystemOneResponse,
    )
    return app


def main() -> None:
    # SageMaker starts the container as `docker run IMAGE serve`; the argument carries no options.
    extra = [arg for arg in sys.argv[1:] if arg != "serve"]
    if extra:
        raise SystemExit(f"unexpected arguments: {extra}")
    app = build_app()
    uvicorn.run(
        app,
        host=os.environ.get("DECIDER_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=_env_int("DECIDER_PORT", 8080, 1, 65535),
        workers=1,
        access_log=False,
        server_header=False,
    )


if __name__ == "__main__":
    main()
