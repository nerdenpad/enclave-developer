"""Dependency-free runtime configuration and HTTP boundary for development inference.

References verified 2026-09-17:
https://modal.com/docs/reference/modal.web_server
https://docs.vllm.ai/en/stable/usage/security/#api-key-authentication-limitations
https://huggingface.co/Qwen/Qwen2.5-3B-Instruct/commit/aa8e72537993ba99e69dfaafa59ed015b17504d1
"""

from __future__ import annotations

import atexit
import hmac
import os
import re
import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

MODAL_VERSION = "1.5.5"
VLLM_VERSION = "0.29.0"
# Release v0.29.0 defaults to CUDA 13 on PyPI; select the CUDA 12.9 binary explicitly.
VLLM_CUDA_VERSION = "0.29.0+cu129"
TORCH_CUDA_VERSION = "2.13.0+cu129"
VLLM_WHEEL = (
    "https://github.com/vllm-project/vllm/releases/download/v0.29.0/"
    "vllm-0.29.0%2Bcu129-cp38-abi3-manylinux_2_28_x86_64.whl"
    "#sha256=22e8d8fec755986b3ad964004a1f8c65a55626ec948354bdbe95993e6b0289fe"
)
MODEL_NAME = "Qwen/Qwen2.5-3B-Instruct"
MODEL_REVISION = "aa8e72537993ba99e69dfaafa59ed015b17504d1"
MODEL_PATH = "/opt/enclave-model"
SECRET_NAME = "enclave-inference"
KEY_PATTERN = re.compile(r"[A-Za-z0-9_-]{32,256}", re.ASCII)


@dataclass(frozen=True)
class ServingConfig:
    app_name: str = "enclave-inference-dev"
    gpu: str = "L4"
    min_containers: int = 0
    max_containers: int = 1
    scaledown_window: int = 60
    max_inputs: int = 2
    port: int = 8000
    max_model_len: int = 4096
    max_num_seqs: int = 2
    startup_timeout: int = 600
    request_timeout: int = 600
    gpu_memory_utilization: float = 0.85

    def __post_init__(self):
        if (self.gpu != "L4" or self.min_containers != 0 or self.max_containers != 1
                or self.scaledown_window != 60 or not 1 <= self.max_inputs <= 2):
            raise ValueError("Development profile requires one scale-to-zero L4 and at most two concurrent inputs")
        if not (1 <= self.max_num_seqs <= self.max_inputs and 256 <= self.max_model_len <= 4096
                and 0 < self.gpu_memory_utilization <= 0.9 and 1 <= self.port <= 65535
                and 0 < self.startup_timeout <= 600 and 0 < self.request_timeout <= 600):
            raise ValueError("Invalid development inference resource limits")


CONFIG = ServingConfig()


def validate_api_key(value: str | None) -> str:
    if not isinstance(value, str) or not KEY_PATTERN.fullmatch(value):
        raise ValueError("INFERENCE_API_KEY must contain 32..256 ASCII letters, digits, '-' or '_' without whitespace")
    return value


def build_environment(source: Mapping[str, str]) -> dict[str, str]:
    """Pass credentials through the child environment, never command arguments."""
    key = validate_api_key(source.get("INFERENCE_API_KEY"))
    result = dict(source)
    result.pop("INFERENCE_API_KEY", None)
    result.update({
        "VLLM_API_KEY": key,
        "VLLM_TARGET_DEVICE": "cuda",
        # v0.29's MRV2 sampler otherwise JIT-builds FlashInfer kernels using nvcc,
        # which is absent from this runtime-only image. Use its native fallback.
        "VLLM_USE_FLASHINFER_SAMPLER": "0",
        "VLLM_LOGGING_LEVEL": "ERROR",
        "VLLM_DEBUG_LOG_API_SERVER_RESPONSE": "0",
        "VLLM_TRACE_FUNCTION": "0",
        "VLLM_ALLOW_RUNTIME_LORA_UPDATING": "0",
        "VLLM_NO_USAGE_STATS": "1",
        "DO_NOT_TRACK": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        # vLLM's subprocess must find the explicitly copied middleware module.
        "PYTHONPATH": "/root",
    })
    return result


def build_command(config: ServingConfig = CONFIG) -> list[str]:
    return [
        "vllm", "serve", MODEL_PATH,
        "--served-model-name", MODEL_NAME,
        "--host", "0.0.0.0", "--port", str(config.port),
        "--dtype", "bfloat16", "--load-format", "safetensors",
        "--tensor-parallel-size", "1",
        "--max-model-len", str(config.max_model_len),
        "--max-num-seqs", str(config.max_num_seqs),
        "--max-num-batched-tokens", str(config.max_model_len),
        "--gpu-memory-utilization", str(config.gpu_memory_utilization),
        "--generation-config", "vllm",
        "--enforce-eager", "--no-enable-prefix-caching",
        "--no-enable-log-requests", "--no-enable-log-outputs",
        "--disable-log-stats", "--disable-uvicorn-access-log",
        "--uvicorn-log-level", "error", "--disable-fastapi-docs",
        "--middleware", "infra.modal.runtime.BearerAuthMiddleware",
    ]


def download_model(repo_id: str, revision: str) -> None:
    """CPU image-build step, not a running GPU or persistent mutable cache."""
    if repo_id != MODEL_NAME or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("Model download requires the configured repository and an immutable commit")
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=repo_id, revision=revision, local_dir=MODEL_PATH,
        allow_patterns=["*.json", "*.safetensors", "*.txt", "LICENSE"],
        token=False,  # This public, ungated repository does not require HF_TOKEN.
    )


def validate_cuda_build(vllm_version: str, torch_cuda: str, linkage: str, cli_help: str, *, torch_version: str) -> None:
    """Fail the CPU image build before a mismatched wheel can request a GPU."""
    if vllm_version != VLLM_CUDA_VERSION or torch_cuda != "12.9" or torch_version != TORCH_CUDA_VERSION:
        raise RuntimeError("The development image requires vLLM 0.29.0+cu129 and PyTorch CUDA 12.9")
    missing = [line.strip().split()[0] for line in linkage.splitlines() if "not found" in line]
    # CPU builders lack the GPU driver's library. All CUDA runtime and torch
    # libraries must still resolve; in particular libcudart.so.13 must never slip through.
    if any(library != "libcuda.so.1" for library in missing):
        raise RuntimeError("Unresolved inference native libraries: " + ", ".join(missing))
    for flag in build_command():
        if flag.startswith("--") and flag.replace("--no-", "--", 1) not in cli_help:
            raise RuntimeError("Installed vLLM does not support configured option: " + flag)


def run_build_check(command: list[str], environment: dict[str, str], timeout: int) -> str:
    """Builds have no injected secrets; retain bounded diagnostics on failure."""
    result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, env=environment)
    if result.returncode:
        raise RuntimeError(f"Image preflight command failed ({result.returncode}): {' '.join(command)}\n"
                           + (result.stdout + result.stderr)[-16000:])
    return result.stdout


def validate_gpu_install() -> None:
    """CPU-only dependency, native linkage, and real CLI preflight during build."""
    from importlib import import_module, metadata
    from pathlib import Path
    import torch

    package_dir = Path(metadata.distribution("vllm").locate_file("vllm"))
    native = list(package_dir.glob("_C_stable_libtorch*.so"))
    if len(native) != 1:
        raise RuntimeError("Expected one vLLM stable native extension")
    site_packages = package_dir.parent
    libraries = [str(site_packages / "torch" / "lib")]
    libraries.extend(str(path) for path in (site_packages / "nvidia").glob("*/lib"))
    environment = dict(os.environ)
    environment["LD_LIBRARY_PATH"] = ":".join(libraries + [environment.get("LD_LIBRARY_PATH", "")])
    run_build_check(["python", "-m", "pip", "check"], environment, 60)
    linkage = run_build_check(["ldd", str(native[0])], environment, 30)
    # The pinned vLLM release supports this explicit CPU target for CI with an
    # accelerator wheel. It affects only CLI inspection, never the GPU server.
    cli = run_build_check(["vllm", "serve", "--help=all"], {**environment, "VLLM_TARGET_DEVICE": "cpu"}, 120)
    validate_cuda_build(metadata.version("vllm"), torch.version.cuda, linkage, cli, torch_version=metadata.version("torch"))
    try:
        import_module("vllm._C_stable_libtorch")
    except ImportError as error:
        if "libcuda.so.1" not in str(error):
            raise


def wait_for_ready(process, api_key: str, config: ServingConfig = CONFIG, *,
                   opener=urlopen, clock=time.monotonic, sleep=time.sleep) -> None:
    deadline = clock() + config.startup_timeout
    request = Request(f"http://127.0.0.1:{config.port}/health", headers={"Authorization": f"Bearer {api_key}"})
    while clock() < deadline:
        if process.poll() is not None:
            raise RuntimeError("vLLM exited before becoming ready")
        try:
            with opener(request, timeout=5) as response:
                if response.status == 200:
                    return
        except HTTPError as error:
            if error.code in (401, 403):
                raise RuntimeError("vLLM rejected the configured inference key") from None
        except (URLError, TimeoutError):
            pass
        sleep(1)
    raise TimeoutError("vLLM did not become healthy before the startup deadline")


def stop_process(process) -> None:
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def start_server(config: ServingConfig = CONFIG) -> None:
    environment = build_environment(os.environ)
    process = subprocess.Popen(build_command(config), env=environment, start_new_session=True)
    try:
        wait_for_ready(process, environment["VLLM_API_KEY"], config)
    except BaseException:
        stop_process(process)
        raise
    atexit.register(stop_process, process)


class BearerAuthMiddleware:
    """Authenticate every HTTP route; expose only the development API surface.

    vLLM's built-in VLLM_API_KEY guard deliberately excludes some inference and
    operational routes. This outer middleware runs before those route handlers.
    """

    ALLOWED_ROUTES = frozenset({
        ("GET", "/health"), ("GET", "/v1/models"),
        ("POST", "/v1/chat/completions"), ("POST", "/v1/completions"),
    })

    def __init__(self, app):
        self.app = app
        self.token = validate_api_key(os.environ.get("VLLM_API_KEY")).encode("ascii")

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] != "http":
            await send({"type": "websocket.close", "code": 1008})
            return
        headers = [value for name, value in scope.get("headers", []) if name.lower() == b"authorization"]
        parts = headers[0].split(b" ", 1) if len(headers) == 1 else []
        if len(parts) != 2 or parts[0].lower() != b"bearer" or not hmac.compare_digest(parts[1], self.token):
            await self.respond(send, 401, b'{"error":{"message":"Unauthorized","type":"authentication_error"}}')
            return
        if (scope.get("method"), scope.get("path")) not in self.ALLOWED_ROUTES:
            await self.respond(send, 404, b'{"error":{"message":"Not found","type":"not_found"}}')
            return
        return await self.app(scope, receive, send)

    @staticmethod
    async def respond(send, status: int, body: bytes):
        headers = [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]
        if status == 401:
            headers.append((b"www-authenticate", b"Bearer"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})
