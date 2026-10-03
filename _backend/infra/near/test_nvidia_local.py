"""Local-verifier boundary tests; native verification is represented by a trusted stub.

No GPU/network/native installation is used. Synthetic device IDs are intentional;
the independently pinned official SDK was probed separately against real evidence.
"""
import asyncio
import copy
import gc
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import verifier as v
import verify as cli
from test_verifier import NOW, NONCE, fixture
from test_archive_replay import archive_fixture, HISTORICAL_TIME, REPLAY_TIME


def local_identity():
    return {"mode": "local", "sdkVersion": v.NVAT_VERSION,
            "binarySha256": v.NVAT_BINARY_SHA256,
            "librarySha256": v.NVAT_LIBRARY_SHA256}


def local_output(nonce=NONCE, count=2):
    cert = {"x-nvidia-cert-expiration-date": "9999-12-31T23:59:59Z",
            "x-nvidia-cert-status": "valid", "x-nvidia-cert-ocsp-status": "good",
            "x-nvidia-cert-revocation-reason": None,
            "x-nvidia-cert-ocsp-nonce-matches": True,
            "x-nvidia-cert-ocsp-response-valid": True}
    claims = []
    for i in range(count):
        claims.append({"eat_nonce": nonce, "measres": "success", "secboot": True,
                       "dbgstat": "disabled", "hwmodel": "GH100", "ueid": f"synthetic-device-{i}",
                       "x-nvidia-device-type": "gpu", "x-nvidia-gpu-claims-version": "3.0",
                       "x-nvidia-mismatch-measurement-records": None,
                       **{key: True for key in v.NVAT_TRUE_CLAIMS},
                       **{key: copy.deepcopy(cert) for key in v.NVAT_CERT_CLAIMS}})
    # A bogus unsigned EAT must be irrelevant, even when claims are valid.
    return {"result_code": 0, "result_message": "Ok", "claims": claims,
            "detached_eat": [["JWT", "unsigned-and-untrusted"], {}]}


class LocalClaimsTests(unittest.TestCase):
    def rejected(self, output, code="NVIDIA_GPU_REJECTED"):
        with self.assertRaisesRegex(v.VerificationError, code):
            v.verify_nvat_claims(output, bytes.fromhex(NONCE), 2, NOW)

    def test_valid_claims_do_not_depend_on_unsigned_eat(self):
        output = local_output()
        self.assertEqual(v.verify_nvat_claims(output, bytes.fromhex(NONCE), 2, NOW), ["GH100", "GH100"])
        output.pop("detached_eat")
        self.assertEqual(v.verify_nvat_claims(output, bytes.fromhex(NONCE), 2, NOW), ["GH100", "GH100"])

    def test_every_security_flag_requires_explicit_boolean_true(self):
        for key in (*v.NVAT_TRUE_CLAIMS, "secboot"):
            for value in (False, None, 1, "true"):
                with self.subTest(key=key, value=value):
                    output = local_output()
                    output["claims"][1][key] = value
                    self.rejected(output)

    def test_sdk_overall_policy_failure_cannot_be_replaced_by_claims_or_eat(self):
        for code in (2, 11, 12, True, "0"):
            output = local_output()
            output["result_code"] = code
            self.rejected(output, "NVIDIA_RESULT_REJECTED")
        self.rejected({"result_code": 0, "detached_eat": local_output()["detached_eat"]},
                      "NVIDIA_GPU_SET_INVALID")

    def test_rejects_nonce_duplicates_missing_devices_and_changed_security_state(self):
        for key, value, code in (
                ("eat_nonce", "ff" * 32, "NVIDIA_NONCE_INVALID"),
                ("ueid", "synthetic-device-0", "NVIDIA_GPU_SET_INVALID"),
                ("dbgstat", "enabled", "NVIDIA_GPU_REJECTED"),
                ("measres", "failure", "NVIDIA_GPU_REJECTED"),
                ("x-nvidia-device-type", "nvswitch", "NVIDIA_GPU_REJECTED"),
                ("x-nvidia-gpu-claims-version", "2.0", "NVIDIA_GPU_REJECTED"),
                ("x-nvidia-attestation-warning", "warning", "NVIDIA_GPU_REJECTED"),
                ("x-nvidia-mismatch-measurement-records", [{"index": 7}], "NVIDIA_GPU_REJECTED")):
            output = local_output()
            output["claims"][1][key] = value
            self.rejected(output, code)
        output = local_output()
        output["claims"].pop()
        self.rejected(output, "NVIDIA_GPU_SET_INVALID")

    def test_all_certificate_and_ocsp_chains_are_required_and_unexpired(self):
        for chain in v.NVAT_CERT_CLAIMS:
            for key, value in (("x-nvidia-cert-status", "expired"),
                               ("x-nvidia-cert-ocsp-status", "revoked"),
                               ("x-nvidia-cert-ocsp-nonce-matches", False),
                               ("x-nvidia-cert-ocsp-response-valid", False),
                               ("x-nvidia-cert-revocation-reason", "keyCompromise")):
                output = local_output()
                output["claims"][1][chain][key] = value
                self.rejected(output)
            output = local_output()
            output["claims"][1][chain]["x-nvidia-cert-expiration-date"] = v.iso(NOW + 299)
            self.rejected(output, "NVIDIA_TIME_INVALID")
            output["claims"][1][chain].pop("x-nvidia-cert-ocsp-response-valid")
            self.rejected(output)


class LocalConfigurationTests(unittest.TestCase):
    def test_loader_metacharacters_are_rejected_before_file_resolution(self):
        _, policy, _, _ = fixture()
        policy["nvidiaVerifier"] = local_identity()
        for suffix in ("directory:other", "$ORIGIN"):
            library = str(Path(tempfile.gettempdir()) / suffix / "libnvat.so.1.2.2")
            with patch.dict(os.environ, {"NVIDIA_VERIFIER_MODE": "local",
                                         "NVIDIA_NVAT_BINARY": sys.executable,
                                         "NVIDIA_NVAT_LIBRARY": library}, clear=True), \
                    patch.object(v.Path, "resolve", side_effect=AssertionError("must reject before resolution")):
                with self.assertRaisesRegex(v.VerificationError, "NVIDIA_LOCAL_CONFIG_INVALID"):
                    v.nvidia_local_config(policy)

    @unittest.skipUnless(os.name == "posix", "Official local SDK and loader paths are Linux-only")
    def test_symlink_paths_are_canonical_and_resolved_loader_tokens_rejected(self):
        _, policy, _, _ = fixture()
        policy["nvidiaVerifier"] = local_identity()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            binary, library = root / "nvattest", root / "libnvat.so.1.2.2"
            binary.touch()
            library.touch()
            link = root / "alias"
            link.symlink_to(root, target_is_directory=True)
            environment = {"NVIDIA_VERIFIER_MODE": "local", "NVIDIA_NVAT_BINARY": str(link / binary.name),
                           "NVIDIA_NVAT_LIBRARY": str(link / library.name)}
            with patch.dict(os.environ, environment, clear=True):
                config = v.nvidia_local_config(policy)
                self.assertEqual(config["binary"], binary)
                self.assertEqual(config["library"], library)
            other = root / "$ORIGIN"
            other.mkdir()
            (other / library.name).touch()
            link.unlink()
            link.symlink_to(other, target_is_directory=True)
            environment["NVIDIA_NVAT_BINARY"] = str(binary)
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(v.VerificationError, "NVIDIA_LOCAL_CONFIG_INVALID"):
                    v.nvidia_local_config(policy)

    def test_mode_must_be_explicitly_reviewed_in_both_env_and_policy(self):
        _, policy, _, _ = fixture()
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(v.nvidia_local_config(policy))
            policy["nvidiaVerifier"] = local_identity()
            v.validate_policy(policy, NOW)
            with self.assertRaisesRegex(v.VerificationError, "NVIDIA_VERIFIER_MISMATCH"):
                v.nvidia_local_config(policy)
        with patch.dict(os.environ, {"NVIDIA_VERIFIER_MODE": "local"}, clear=True):
            with self.assertRaisesRegex(v.VerificationError, "NVIDIA_LOCAL_CONFIG_INVALID"):
                v.nvidia_local_config(policy)
            policy.pop("nvidiaVerifier")
            with self.assertRaisesRegex(v.VerificationError, "NVIDIA_VERIFIER_MISMATCH"):
                v.nvidia_local_config(policy)

    def test_changed_reviewed_sdk_or_pins_are_not_accepted(self):
        for key in ("sdkVersion", "binarySha256", "librarySha256", "mode"):
            _, policy, _, _ = fixture()
            policy["nvidiaVerifier"] = local_identity()
            policy["nvidiaVerifier"][key] = "changed"
            with self.assertRaisesRegex(v.VerificationError, "POLICY_INVALID"):
                v.validate_policy(policy, NOW)

    def test_loader_soname_must_match_the_reviewed_library_not_just_its_sibling(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            binary, library = directory / "nvattest", directory / "libnvat.so.1.2.2"
            binary.write_bytes(b"synthetic binary")
            library.write_bytes(b"synthetic library")
            config = {"binary": binary, "library": library,
                      "binarySha256": v.digest(binary.read_bytes()),
                      "librarySha256": v.digest(library.read_bytes())}
            (directory / "libnvat.so.1").write_bytes(b"substituted library")
            with self.assertRaisesRegex(v.VerificationError, "NVIDIA_IMPLEMENTATION_CHANGED"):
                v.verify_nvat_files(config)
            (directory / "libnvat.so.1").write_bytes(library.read_bytes())
            v.verify_nvat_files(config)
            binary.write_bytes(b"changed binary")
            with self.assertRaisesRegex(v.VerificationError, "NVIDIA_IMPLEMENTATION_CHANGED"):
                v.verify_nvat_files(config)


class LocalBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.document, self.policy, self.cpu, self.manager = fixture()
        self.policy["nvidiaVerifier"] = local_identity()
        self.payload = {"nonce": NONCE, "arch": "HOPPER", "evidence_list": [
            {"arch": "HOPPER", "nonce": NONCE, "certificate": "original-certificate", "evidence": f"original-spdm-{i}"}
            for i in range(2)]}
        self.document["attestation"]["nvidia_payload"] = copy.deepcopy(self.payload)
        self.policy["profiles"][0]["gpuCount"] = 2
        self.policy["validUntil"] = v.iso(NOW + 86400)
        self.config = {**local_identity(), "binary": Path("/trusted/bin/nvattest"),
                       "library": Path("/trusted/lib/libnvat.so.1.2.2")}
        self.output, self.invocations = local_output(), []
        self.program = None
        self.processes = []
        self.real_spawn = asyncio.create_subprocess_exec

        async def trusted_stub(*args, **kwargs):
            evidence_path = Path(args[args.index("--gpu-evidence-file") + 1])
            self.invocations.append((args, copy.deepcopy(kwargs["env"]), evidence_path.read_bytes()))
            # Exercise actual asynchronous pipe draining/termination using a
            # CPU-only child, while representing the pinned native SDK in tests.
            program = self.program or "import sys;sys.stdout.write(" + repr(json.dumps(self.output)) + ")"
            process = await self.real_spawn(sys.executable, "-c", program, **kwargs)
            self.processes.append(process)
            return process

        patches = [patch.object(v, "nvidia_local_config", return_value=self.config),
                   patch.object(v, "verify_nvat_files"),
                   patch.object(v, "verify_tdx", new=AsyncMock(side_effect=lambda quote: copy.deepcopy(
                       self.cpu if quote == "main" else self.manager))),
                   patch.object(v, "http_json", side_effect=AssertionError("NRAS must not be called")),
                   patch.object(v.asyncio, "create_subprocess_exec", side_effect=trusted_stub),
                   patch.object(v.time, "time", return_value=NOW)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)

    async def test_live_and_archive_independently_run_original_raw_evidence(self):
        saved = await v.verify(self.document, self.policy)
        self.assertEqual(saved["nvidiaEvidence"], v.nvat_artifact(self.payload, self.config))
        self.assertNotIn("claims", saved["nvidiaEvidence"])
        self.document["archivedVerdict"] = saved
        result = await v.verify_direct_archive(self.document, self.policy)
        self.assertEqual(result["attestationRef"], saved["attestationRef"])
        self.assertTrue(result["archivedHardwareVerified"])
        self.assertEqual(len(self.invocations), 2)
        for args, environment, evidence in self.invocations:
            self.assertEqual(json.loads(evidence), self.payload["evidence_list"])
            self.assertIn("--verify-rim-signatures", args)
            self.assertIn("--verify-rim-cert-chain", args)
            self.assertNotIn("--relying-party-policy", args)
            self.assertEqual(args[args.index("--verifier") + 1], "local")
            self.assertEqual(args[args.index("--nonce") + 1], NONCE)
            self.assertEqual(environment, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8",
                                           "LD_LIBRARY_PATH": str(self.config["library"].parent)})

    async def test_forged_saved_verdict_cannot_replace_raw_gpu_reverification(self):
        saved = await v.verify(self.document, self.policy)
        self.document["archivedVerdict"] = saved
        # Rebinding all cached hashes does not remove the native invocation.
        self.output["claims"][1]["x-nvidia-gpu-attestation-report-signature-verified"] = False
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_GPU_REJECTED"):
            await v.verify_direct_archive(self.document, self.policy)
        self.assertEqual(len(self.invocations), 2)

    async def test_cloud_replay_reruns_each_model_without_nras_or_unsigned_tokens(self):
        cloud, policy, cpus = archive_fixture()
        policy["nvidiaVerifier"] = local_identity()
        payload = cloud["attestation"]["model_attestations"][0]["nvidia_payload"]
        for item in payload["evidence_list"]:
            item.update(arch=payload["arch"], nonce=payload["nonce"])
        self.output = local_output(payload["nonce"], len(payload["evidence_list"]))
        for claim in self.output["claims"]:
            claim["hwmodel"] = policy["profiles"][0]["gpuModels"][0]
        with patch.object(v, "verify_tdx", new=AsyncMock(side_effect=lambda quote: copy.deepcopy(cpus[quote]))), \
                patch.object(v.time, "time", return_value=HISTORICAL_TIME) as clock:
            saved = await v.verify_cloud(cloud, policy)
            cloud["archivedVerdict"] = saved
            clock.return_value = REPLAY_TIME
            result = await v.verify_cloud_archive(cloud, policy)
        self.assertEqual(result["attestationRef"], saved["attestationRef"])
        self.assertTrue(result["archivedHardwareVerified"])
        self.assertEqual(len(self.invocations), 2)
        self.assertEqual(json.loads(self.invocations[-1][2]), payload["evidence_list"])

    async def test_modified_archive_implementation_or_payload_fails_before_process(self):
        saved = await v.verify(self.document, self.policy)
        self.document["archivedVerdict"] = saved
        saved["nvidiaEvidence"]["binarySha256"] = "00" * 32
        with self.assertRaisesRegex(v.VerificationError, "ARCHIVE_INVALID"):
            await v.verify_direct_archive(self.document, self.policy)
        self.assertEqual(len(self.invocations), 1)

    async def test_wrong_raw_nonce_cannot_be_overwritten_to_match_expected_nonce(self):
        self.document["attestation"]["nvidia_payload"]["evidence_list"][1]["nonce"] = "ff" * 32
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_NONCE_INVALID"):
            await v.verify(self.document, self.policy)
        self.assertEqual(self.invocations, [])

    async def test_process_timeout_and_output_bound_terminate_the_child(self):
        for program, limit, code in (
                ("import time;time.sleep(30)", 0.05, "NVIDIA_LOCAL_TIMEOUT"),
                ("import sys;sys.stdout.write('x'*2100000);sys.stdout.flush()", 5, "NVIDIA_LOCAL_OUTPUT_INVALID")):
            with self.subTest(code=code):
                self.program = program
                with patch.object(v, "NVAT_TIMEOUT_SECONDS", limit):
                    with self.assertRaisesRegex(v.VerificationError, code):
                        await v.verify(self.document, self.policy)
                self.assertIsNotNone(self.processes[-1].returncode)

    async def test_outer_verification_cancellation_reaps_the_native_child(self):
        self.program = "import time;time.sleep(30)"
        loop = asyncio.get_running_loop()
        previous_handler, unhandled = loop.get_exception_handler(), []
        loop.set_exception_handler(lambda _, context: unhandled.append(context))
        task = asyncio.create_task(cli.run_verification(v.verify, self.document, self.policy))
        try:
            for _ in range(100):
                if self.processes:
                    break
                await asyncio.sleep(0.01)
            self.assertTrue(self.processes)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertIsNotNone(self.processes[-1].returncode)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            del task
            gc.collect()
            await asyncio.sleep(0)
            loop.set_exception_handler(previous_handler)
        self.assertEqual(unhandled, [])

    async def test_cancellation_before_aggregate_settles_consumes_its_exception(self):
        self.program = "import time;time.sleep(30)"
        loop = asyncio.get_running_loop()
        previous_handler, unhandled = loop.get_exception_handler(), []
        loop.set_exception_handler(lambda _, context: unhandled.append(context))
        real_wait_for = asyncio.wait_for

        async def cancellation_race(awaitable, timeout):
            if timeout == v.NVAT_TIMEOUT_SECONDS:
                # Model termination while wait_for is exiting, before child
                # cancellation callbacks settle its original aggregate future.
                await asyncio.sleep(0)
                raise asyncio.CancelledError
            return await real_wait_for(awaitable, timeout)

        try:
            with patch.object(v.asyncio, "wait_for", side_effect=cancellation_race):
                with self.assertRaises(asyncio.CancelledError):
                    await v.verify(self.document, self.policy)
            self.assertIsNotNone(self.processes[-1].returncode)
            gc.collect()
            await asyncio.sleep(0)
            self.assertEqual(unhandled, [])
        finally:
            loop.set_exception_handler(previous_handler)

    async def test_invalid_json_and_nonzero_process_exit_fail_closed(self):
        for program, code in (("print('not JSON')", "NVIDIA_LOCAL_OUTPUT_INVALID"),
                              ("import sys;print('{}');sys.exit(12)", "NVIDIA_RESULT_REJECTED")):
            self.program = program
            with self.assertRaisesRegex(v.VerificationError, code):
                await v.verify(self.document, self.policy)


class PosixParentTerminationTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "posix", "Requires actual UNIX SIGTERM delivery")
    def test_parent_sigterm_cancels_verification_and_reaps_native_child(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            child_pid_file, policy_file = directory / "child.pid", directory / "policy.json"
            policy_file.write_text("{}")
            child_program = ("import os,time;from pathlib import Path;Path(" + repr(str(child_pid_file))
                             + ").write_text(str(os.getpid()));time.sleep(30)")
            launcher = directory / "outer.py"
            source_dir = str(Path(v.__file__).parent)
            launcher.write_text(
                "import asyncio,sys\nfrom pathlib import Path\n"
                + "sys.path.insert(0," + repr(source_dir) + ")\nimport verifier as v\nimport verify as cli\n"
                + "real_spawn=asyncio.create_subprocess_exec\n"
                + "async def stub(*args,**kwargs):\n return await real_spawn(sys.executable,'-c',"
                + repr(child_program) + ",**kwargs)\n"
                + "v.asyncio.create_subprocess_exec=stub\nv.verify_nvat_files=lambda _:None\n"
                + "async def operation(document,policy):\n"
                + " return await v.verify_nvidia_local({'arch':'HOPPER','nonce':'" + NONCE
                + "','evidence_list':[{'arch':'HOPPER','nonce':'" + NONCE
                + "','certificate':'synthetic','evidence':'synthetic'}]},bytes.fromhex('" + NONCE
                + "'),{'binary':Path('/trusted/bin/nvattest'),'library':Path('/trusted/lib/libnvat.so.1.2.2')})\n"
                + "cli.verify=operation\nsys.argv=['verify.py','--policy'," + repr(str(policy_file))
                + "]\nraise SystemExit(cli.main())\n")
            outer = subprocess.Popen([sys.executable, str(launcher)], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child_pid = None
            try:
                outer.stdin.write(b"{}")
                outer.stdin.close()
                outer.stdin = None
                deadline = time.monotonic() + 5
                while not child_pid_file.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(child_pid_file.exists())
                child_pid = int(child_pid_file.read_text())
                outer.send_signal(signal.SIGTERM)
                stdout, stderr = outer.communicate(timeout=8)
                self.assertEqual(outer.returncode, 1)
                self.assertEqual(json.loads(stdout), {"ok": False, "error": "VERIFICATION_ABORTED"})
                self.assertEqual(stderr, b"")
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
            finally:
                if outer.poll() is None:
                    outer.kill()
                    outer.communicate(timeout=5)
                if child_pid is not None:
                    try:
                        os.kill(child_pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass


if __name__ == "__main__":
    unittest.main()
