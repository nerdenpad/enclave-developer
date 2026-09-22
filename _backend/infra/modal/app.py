"""Development GPU endpoint. Run deployment commands from the repository root.

Local checks (no cloud resources):
    python -m unittest discover -s infra/modal -p "test_*.py" -v
    python -m py_compile infra/modal/app.py infra/modal/runtime.py

After installing requirements.txt and provisioning the enclave-inference secret:
    python -m modal deploy infra/modal/app.py

The deployment URL printed by Modal exposes /v1/chat/completions and /v1/models.
Use Authorization: Bearer <INFERENCE_API_KEY>. This is ordinary development GPU
inference, with no confidential-computing or hardware-attestation guarantee.
"""

import modal

from infra.modal.runtime import (
    CONFIG, MODEL_NAME, MODEL_REVISION, SECRET_NAME, VLLM_VERSION, VLLM_WHEEL, TORCH_CUDA_VERSION,
    download_model, start_server, validate_gpu_install,
)

app = modal.App(CONFIG.app_name)

# Building is deferred until an explicit Modal run/deploy. No HF secret or volume
# is needed: immutable public weights are baked into a reusable CPU-built image.
image = (
    modal.Image.debian_slim(python_version="3.12")
    # Retain the cached dependency installation, then select the exact native
    # flavor separately: PyPI's unqualified 0.29.0 wheel is compiled for CUDA 13.
    .pip_install(f"vllm=={VLLM_VERSION}", extra_index_url="https://download.pytorch.org/whl/cu129")
    .pip_install(VLLM_WHEEL, extra_options="--no-deps")
    # Resolve the CUDA-specific wheel's complete requirements and explicitly pin
    # torch's CUDA flavor while preserving the two cached installation layers.
    .pip_install(VLLM_WHEEL, f"torch=={TORCH_CUDA_VERSION}", extra_index_url="https://download.pytorch.org/whl/cu129")
    .env({"HF_HUB_DISABLE_TELEMETRY": "1", "DO_NOT_TRACK": "1"})
    .add_local_python_source("infra.modal.runtime", copy=True)
    .run_function(validate_gpu_install, timeout=180)
    .run_function(download_model, kwargs={"repo_id": MODEL_NAME, "revision": MODEL_REVISION}, timeout=1800)
)


@app.function(
    image=image,
    gpu=CONFIG.gpu,
    cpu=4,
    memory=16384,
    min_containers=CONFIG.min_containers,
    max_containers=CONFIG.max_containers,
    buffer_containers=0,
    scaledown_window=CONFIG.scaledown_window,
    startup_timeout=CONFIG.startup_timeout,
    timeout=CONFIG.request_timeout,
    enable_memory_snapshot=False,
    secrets=[modal.Secret.from_name(SECRET_NAME, required_keys=["INFERENCE_API_KEY"])],
)
@modal.concurrent(max_inputs=CONFIG.max_inputs)
@modal.web_server(port=CONFIG.port, startup_timeout=CONFIG.startup_timeout)
def serve():
    start_server()
