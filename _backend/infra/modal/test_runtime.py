"""Run with stdlib unittest; no Modal account, SDK, GPU, or network needed."""

import contextlib
import io
import os
from pathlib import Path
import subprocess
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, Mock, patch
from urllib.error import HTTPError, URLError

from infra.modal import runtime

KEY = "test_only_" + "a" * 32


class ConfigurationTests(unittest.TestCase):
    def test_default_profile_caps_spending_and_concurrency(self):
        cfg = runtime.CONFIG
        self.assertEqual((cfg.gpu, cfg.min_containers, cfg.max_containers), ("L4", 0, 1))
        self.assertEqual(cfg.scaledown_window, 60)
        self.assertLessEqual(cfg.max_num_seqs, cfg.max_inputs)
        self.assertLessEqual(cfg.max_model_len, 4096)
        self.assertRegex(runtime.MODEL_REVISION, r"^[0-9a-f]{40}$")

    def test_resource_limits_reject_expensive_or_invalid_overrides(self):
        for field, value in [("gpu", "H100"), ("min_containers", 1), ("max_containers", 2),
                             ("scaledown_window", 300), ("max_inputs", 3), ("max_num_seqs", 3),
                             ("max_model_len", 8192), ("gpu_memory_utilization", 1), ("port", 0),
                             ("startup_timeout", 0), ("request_timeout", 601)]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                runtime.ServingConfig(**{field: value})

    def test_sdk_and_gpu_dependency_files_match_pins(self):
        directory = Path(__file__).parent
        self.assertIn(f"modal=={runtime.MODAL_VERSION}", (directory / "requirements.txt").read_text())
        self.assertIn(runtime.VLLM_WHEEL, (directory / "requirements-gpu.txt").read_text())
        self.assertIn("torch==2.13.0+cu129", (directory / "requirements-gpu.txt").read_text())

    def test_empty_weak_whitespace_non_ascii_and_oversize_keys_fail_without_echo(self):
        for key in [None, "", "short-secret", "x" * 31, "x" * 257, "x" * 32 + "\n",
                    " " + "x" * 32, "я" * 32, "x" * 32 + "=", "x" * 32 + "\x00"]:
            with self.subTest(kind=type(key).__name__), self.assertRaises(ValueError) as caught:
                runtime.validate_api_key(key)
            if key:
                self.assertNotIn(key, str(caught.exception))

    def test_valid_base64url_and_hex_boundaries(self):
        for key in ["a" * 32, "09abcdef" * 32, KEY, "-" * 255 + "_"]:
            self.assertEqual(runtime.validate_api_key(key), key)

    def test_environment_maps_key_and_forces_privacy_settings_without_mutating_source(self):
        source = {"INFERENCE_API_KEY": KEY, "PATH": "/bin", "VLLM_API_KEY": "stale",
                  "VLLM_DEBUG_LOG_API_SERVER_RESPONSE": "1", "HF_TOKEN": "optional-hf-token"}
        result = runtime.build_environment(source)
        self.assertEqual(result["VLLM_API_KEY"], KEY)
        self.assertNotIn("INFERENCE_API_KEY", result)
        self.assertEqual(result["PATH"], "/bin")
        self.assertEqual(result["VLLM_DEBUG_LOG_API_SERVER_RESPONSE"], "0")
        self.assertEqual(result["VLLM_TARGET_DEVICE"], "cuda")
        self.assertEqual(result["HF_HUB_OFFLINE"], "1")
        self.assertEqual(source["VLLM_API_KEY"], "stale")

    def test_secret_is_required_even_if_a_stale_vllm_key_exists(self):
        with self.assertRaises(ValueError):
            runtime.build_environment({"VLLM_API_KEY": KEY})

    def test_runtime_image_forces_native_sampling_without_nvcc(self):
        source = {"INFERENCE_API_KEY": KEY, "VLLM_USE_FLASHINFER_SAMPLER": "1"}
        result = runtime.build_environment(source)
        self.assertEqual(result["VLLM_USE_FLASHINFER_SAMPLER"], "0")
        self.assertEqual(source["VLLM_USE_FLASHINFER_SAMPLER"], "1")
        self.assertEqual(result["VLLM_TARGET_DEVICE"], "cuda")

    def test_command_uses_pinned_local_weights_and_never_embeds_credentials(self):
        with patch.dict(os.environ, {"INFERENCE_API_KEY": KEY}, clear=True):
            command = runtime.build_command()
        self.assertEqual(command[:3], ["vllm", "serve", runtime.MODEL_PATH])
        self.assertEqual(command[command.index("--served-model-name") + 1], runtime.MODEL_NAME)
        self.assertNotIn(KEY, " ".join(command))
        self.assertNotIn("--api-key", command)
        self.assertNotIn("--trust-remote-code", command)
        for flag in ["--no-enable-log-requests", "--no-enable-log-outputs", "--disable-uvicorn-access-log",
                     "--no-enable-prefix-caching", "--disable-fastapi-docs", "--enforce-eager"]:
            self.assertIn(flag, command)
        self.assertEqual(command[command.index("--middleware") + 1], "infra.modal.runtime.BearerAuthMiddleware")

    def test_download_is_public_immutable_and_safetensors_only(self):
        download = Mock()
        with patch.dict("sys.modules", {"huggingface_hub": types.SimpleNamespace(snapshot_download=download)}):
            runtime.download_model(runtime.MODEL_NAME, runtime.MODEL_REVISION)
        download.assert_called_once_with(repo_id=runtime.MODEL_NAME, revision=runtime.MODEL_REVISION,
                                         local_dir=runtime.MODEL_PATH, token=False,
                                         allow_patterns=["*.json", "*.safetensors", "*.txt", "LICENSE"])
        for repository, revision in [("other/model", runtime.MODEL_REVISION), (runtime.MODEL_NAME, "main")]:
            with self.assertRaises(ValueError):
                runtime.download_model(repository, revision)

    def test_cuda_preflight_accepts_matching_build_without_cpu_host_gpu_driver(self):
        cli_help = " ".join(runtime.build_command()).replace("--no-", "--")
        runtime.validate_cuda_build("0.29.0+cu129", "12.9", "libcuda.so.1 => not found\nlibcudart.so.12 => /cuda/libcudart.so.12", cli_help, torch_version=runtime.TORCH_CUDA_VERSION)

    def test_cuda_preflight_rejects_the_actual_pypi_cuda13_mismatch(self):
        cli_help = " ".join(runtime.build_command()).replace("--no-", "--")
        with self.assertRaisesRegex(RuntimeError, "requires vLLM"):
            runtime.validate_cuda_build("0.29.0", "12.9", "", cli_help, torch_version=runtime.TORCH_CUDA_VERSION)
        with self.assertRaisesRegex(RuntimeError, "requires vLLM"):
            runtime.validate_cuda_build("0.29.0+cu129", "13.0", "", cli_help, torch_version=runtime.TORCH_CUDA_VERSION)
        with self.assertRaisesRegex(RuntimeError, "libcudart.so.13"):
            runtime.validate_cuda_build("0.29.0+cu129", "12.9", "libcudart.so.13 => not found", cli_help, torch_version=runtime.TORCH_CUDA_VERSION)
        with self.assertRaisesRegex(RuntimeError, "requires vLLM"):
            runtime.validate_cuda_build("0.29.0+cu129", "12.9", "", cli_help, torch_version="2.12.0+cu129")

    def test_cuda_preflight_rejects_an_unsupported_server_option(self):
        with self.assertRaisesRegex(RuntimeError, "does not support configured option"):
            runtime.validate_cuda_build("0.29.0+cu129", "12.9", "", "outdated cli", torch_version=runtime.TORCH_CUDA_VERSION)

    def test_build_command_errors_preserve_stderr_diagnostics_and_are_bounded(self):
        result = subprocess.CompletedProcess(["vllm"], 1, "x" * 20000, "Failed to infer device type")
        with patch.object(runtime.subprocess, "run", return_value=result), self.assertRaisesRegex(RuntimeError, "Failed to infer device type") as caught:
            runtime.run_build_check(["vllm", "serve", "--help=all"], {}, 120)
        self.assertLess(len(str(caught.exception)), 17000)

    def test_successful_build_command_returns_stdout(self):
        result = subprocess.CompletedProcess(["pip"], 0, "No broken requirements found", "")
        with patch.object(runtime.subprocess, "run", return_value=result):
            self.assertEqual(runtime.run_build_check(["python", "-m", "pip", "check"], {}, 60), result.stdout)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.process = Mock()
        self.process.poll.return_value = None

    def test_readiness_waits_for_health_and_authenticates_without_url_credentials(self):
        response = MagicMock()
        response.__enter__.return_value.status = 200
        opener = Mock(side_effect=[URLError("not listening"), response])
        sleep = Mock()
        runtime.wait_for_ready(self.process, KEY, opener=opener, clock=Mock(return_value=0), sleep=sleep)
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:8000/health")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {KEY}")
        sleep.assert_called_once_with(1)

    def test_health_503_retries_without_exposing_response_body(self):
        response = MagicMock()
        response.__enter__.return_value.status = 200
        opener = Mock(side_effect=[HTTPError("health", 503, "starting", {}, None), response])
        runtime.wait_for_ready(self.process, KEY, opener=opener, clock=Mock(return_value=0), sleep=Mock())
        self.assertEqual(opener.call_count, 2)

    def test_readiness_rejects_bad_auth_and_early_process_exit(self):
        for status in (401, 403):
            with self.subTest(status=status), self.assertRaisesRegex(RuntimeError, "rejected the configured"):
                runtime.wait_for_ready(self.process, KEY, opener=Mock(side_effect=HTTPError("health", status, KEY, {}, None)))
        self.process.poll.return_value = 1
        with self.assertRaisesRegex(RuntimeError, "exited before"):
            runtime.wait_for_ready(self.process, KEY)

    def test_readiness_has_a_bounded_deadline(self):
        with self.assertRaisesRegex(TimeoutError, "startup deadline"):
            runtime.wait_for_ready(self.process, KEY, clock=Mock(side_effect=[0, 601]), opener=Mock())

    def test_start_validates_secret_before_creating_a_process(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(runtime.subprocess, "Popen") as popen:
            with self.assertRaises(ValueError):
                runtime.start_server()
        popen.assert_not_called()

    def test_start_uses_environment_only_and_registers_cleanup_after_readiness(self):
        output = io.StringIO()
        with patch.dict(os.environ, {"INFERENCE_API_KEY": KEY}, clear=True), \
                patch.object(runtime.subprocess, "Popen", return_value=self.process) as popen, \
                patch.object(runtime, "wait_for_ready") as ready, patch.object(runtime.atexit, "register") as register, \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            runtime.start_server()
        self.assertNotIn(KEY, str(popen.call_args.args))
        self.assertEqual(popen.call_args.kwargs["env"]["VLLM_API_KEY"], KEY)
        self.assertNotIn("shell", popen.call_args.kwargs)
        ready.assert_called_once_with(self.process, KEY, runtime.CONFIG)
        register.assert_called_once_with(runtime.stop_process, self.process)
        self.assertEqual(output.getvalue(), "")

    def test_failed_start_terminates_child_before_propagating_error(self):
        with patch.dict(os.environ, {"INFERENCE_API_KEY": KEY}, clear=True), \
                patch.object(runtime.subprocess, "Popen", return_value=self.process), \
                patch.object(runtime, "wait_for_ready", side_effect=TimeoutError("deadline")):
            with self.assertRaisesRegex(TimeoutError, "deadline"):
                runtime.start_server()
        self.process.terminate.assert_called_once()

    def test_cleanup_kills_a_stuck_process_but_leaves_exited_process_alone(self):
        self.process.wait.side_effect = [subprocess.TimeoutExpired("vllm", 5), 0]
        runtime.stop_process(self.process)
        self.process.kill.assert_called_once()
        exited = Mock()
        exited.poll.return_value = 0
        runtime.stop_process(exited)
        exited.terminate.assert_not_called()


class AuthenticationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.inner = AsyncMock()
        with patch.dict(os.environ, {"VLLM_API_KEY": KEY}, clear=True):
            self.middleware = runtime.BearerAuthMiddleware(self.inner)
        self.send = AsyncMock()
        self.receive = AsyncMock()

    async def request(self, headers=None, path="/v1/chat/completions", method="POST", kind="http"):
        scope = {"type": kind, "method": method, "path": path, "headers": headers or []}
        await self.middleware(scope, self.receive, self.send)
        return scope

    async def test_missing_or_malformed_bearer_never_reaches_inference(self):
        for headers in [[], [(b"authorization", b"Basic " + KEY.encode())],
                        [(b"authorization", b"Bearer wrong")], [(b"authorization", b"Bearer")],
                        [(b"authorization", b"Bearer  " + KEY.encode())],
                        [(b"authorization", b"Bearer " + KEY.encode())] * 2]:
            with self.subTest(headers_count=len(headers)):
                self.send.reset_mock()
                await self.request(headers)
                self.assertEqual(self.send.call_args_list[0].args[0]["status"], 401)
                self.assertNotIn(KEY, str(self.send.call_args_list))
        self.inner.assert_not_awaited()
        self.receive.assert_not_awaited()

    async def test_auth_applies_to_health_and_builtin_vllm_bypass_routes(self):
        for path in ["/health", "/invocations", "/metrics", "/tokenize", "/v1/models"]:
            self.send.reset_mock()
            await self.request(path=path, method="GET")
            self.assertEqual(self.send.call_args_list[0].args[0]["status"], 401)
        self.inner.assert_not_awaited()

    async def test_correct_bearer_passes_allowed_routes_and_streams_without_buffering(self):
        for method, path in self.middleware.ALLOWED_ROUTES:
            scope = await self.request([(b"Authorization", b"Bearer " + KEY.encode())], path=path, method=method)
            self.inner.assert_awaited_with(scope, self.receive, self.send)
        self.send.assert_not_awaited()
        self.receive.assert_not_awaited()

    async def test_even_authenticated_clients_cannot_access_operational_routes(self):
        for path in ["/metrics", "/invocations", "/openapi.json", "/tokenize", "/v1/load_lora_adapter"]:
            self.send.reset_mock()
            await self.request([(b"authorization", b"Bearer " + KEY.encode())], path=path)
            self.assertEqual(self.send.call_args_list[0].args[0]["status"], 404)
        self.inner.assert_not_awaited()

    async def test_websockets_are_closed_and_lifespan_is_preserved(self):
        await self.request(kind="websocket")
        self.send.assert_awaited_once_with({"type": "websocket.close", "code": 1008})
        scope = await self.request(kind="lifespan")
        self.inner.assert_awaited_once_with(scope, self.receive, self.send)

    def test_middleware_fails_closed_when_runtime_secret_is_missing(self):
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ValueError):
            runtime.BearerAuthMiddleware(self.inner)


if __name__ == "__main__":
    unittest.main()
