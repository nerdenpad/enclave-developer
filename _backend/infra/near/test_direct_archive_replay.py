"""Direct-model archive replay with real NVIDIA JWTs and mocked CPU retrieval.

All workload bindings and authorization execute normally. The public fixture
provides genuine aggregate/device signatures; archive HTTP accepts official JWKS
GET only and forbids a replacement GPU attestation POST.
"""
import base64
import copy
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import verifier as v
from test_archive_replay import PUBLIC, HISTORICAL_TIME, REPLAY_TIME, archive_fixture


class DirectArchiveReplayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cloud, self.policy, self.cpu_results = archive_fixture()
        candidate = cloud["attestation"]["model_attestations"][0]
        self.document = {"nonce": cloud["nonce"], "tlsSpkiSha256": candidate["tls_cert_fingerprint"],
                         "attestation": candidate}
        self.policy.pop("gatewayProfiles")
        self.live = True
        self.calls = []

        def offline_http(method, url, payload=None):
            self.calls.append((method, url))
            if method == "GET" and url == v.NRAS_ORIGIN + "/.well-known/jwks.json":
                return copy.deepcopy(PUBLIC["nvidiaJwks"])
            if self.live and method == "POST" and url == v.NRAS_ORIGIN + "/v3/attest/gpu":
                return copy.deepcopy(PUBLIC["nvidia"])
            raise AssertionError("Direct archive attempted an unexpected HTTP request")

        self.quote_patch = patch.object(v, "verify_tdx", new=AsyncMock(
            side_effect=lambda quote: copy.deepcopy(self.cpu_results[quote])))
        self.http_patch = patch.object(v, "http_json", side_effect=offline_http)
        self.clock_patch = patch.object(v.time, "time", return_value=HISTORICAL_TIME)
        self.quote_patch.start()
        self.http_patch.start()
        self.clock = self.clock_patch.start()
        self.addCleanup(self.quote_patch.stop)
        self.addCleanup(self.http_patch.stop)
        self.addCleanup(self.clock_patch.stop)
        self.document["archivedVerdict"] = await v.verify(self.document, self.policy)
        self.live = False
        self.calls.clear()
        self.clock.return_value = REPLAY_TIME

    @property
    def saved(self):
        return self.document["archivedVerdict"]

    def rebind_reference(self):
        self.saved["nvidiaEvidenceSha256"] = v.digest(v.canonical(self.saved["nvidiaEvidence"]))
        original = {key: self.document[key] for key in ("nonce", "tlsSpkiSha256", "attestation")}
        self.saved["attestationRef"] = "0x" + v.digest(v.canonical({
            "input": original, "policy": self.policy,
            "nvidiaEvidenceSha256": self.saved["nvidiaEvidenceSha256"]}))

    async def rejected(self, code=None):
        with self.assertRaises(v.VerificationError) as caught:
            await v.verify_direct_archive(self.document, self.policy)
        if code:
            self.assertEqual(caught.exception.code, code)

    async def test_direct_replay_preserves_original_reference_and_single_attested_signer(self):
        result = await v.verify_direct_archive(self.document, self.policy)
        self.assertTrue(result["archivedHardwareVerified"])
        self.assertEqual(result["attestationRef"], self.saved["attestationRef"])
        self.assertEqual(result["signingAddress"], self.document["attestation"]["signing_address"])
        self.assertNotIn("allowedSigners", result)
        self.assertEqual(result["nvidiaEvidence"], PUBLIC["nvidia"])
        self.assertEqual(result["verifiedAt"], v.iso(HISTORICAL_TIME))
        self.assertLess(v.timestamp(result["expiresAt"]), REPLAY_TIME)
        self.assertEqual(self.calls, [("GET", v.NRAS_ORIGIN + "/.well-known/jwks.json")])

    async def test_live_direct_rejects_archive_before_http(self):
        with self.assertRaisesRegex(v.VerificationError, "INPUT_INVALID"):
            await v.verify(self.document, self.policy)
        self.assertEqual(self.calls, [])

    async def test_cloud_wrapper_is_not_a_direct_archive(self):
        self.document["attestation"]["gateway_attestation"] = {}
        await self.rejected("ARCHIVE_INVALID")
        self.assertEqual(self.calls, [])

    async def test_saved_bundle_and_verdict_are_required(self):
        original = copy.deepcopy(self.document)
        self.saved.pop("nvidiaEvidence")
        await self.rejected("ARCHIVE_INVALID")
        self.document = original
        self.document.pop("archivedVerdict")
        await self.rejected("ARCHIVE_INVALID")

    async def test_forged_signature_fails_even_after_rebinding_cached_hash_and_reference(self):
        parts = self.saved["nvidiaEvidence"][0][1].split(".")
        signature = bytearray(base64.urlsafe_b64decode(parts[2] + "=" * (-len(parts[2]) % 4)))
        signature[0] ^= 1
        parts[2] = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        self.saved["nvidiaEvidence"][0][1] = ".".join(parts)
        self.rebind_reference()
        await self.rejected("NVIDIA_SIGNATURE_INVALID")

    async def test_device_token_swap_is_rejected_by_signed_aggregate(self):
        bundle = self.saved["nvidiaEvidence"]
        bundle[1]["GPU-0"] = bundle[1]["GPU-1"]
        self.rebind_reference()
        await self.rejected("NVIDIA_GPU_BINDING_INVALID")

    async def test_included_jwks_cannot_replace_trusted_keys(self):
        self.saved["nvidiaJwks"] = PUBLIC["nvidiaJwks"]
        with patch.object(v, "http_json", return_value={"keys": []}):
            await self.rejected("NVIDIA_SIGNATURE_INVALID")

    async def test_modified_reference_digest_signer_and_expiry_are_rejected(self):
        original = copy.deepcopy(self.saved)
        for key, value in (("attestationRef", "0x" + "00" * 32),
                           ("nvidiaEvidenceSha256", "00" * 32),
                           ("signingAddress", "0x" + "00" * 20),
                           ("expiresAt", v.iso(HISTORICAL_TIME + 121))):
            with self.subTest(key=key):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                self.saved[key] = value
                await self.rejected("ARCHIVE_VERDICT_MISMATCH")

    async def test_history_horizon_future_and_signed_token_time_bounds(self):
        original = copy.deepcopy(self.saved)
        for value in (v.iso(REPLAY_TIME + 1), v.iso(REPLAY_TIME - 31 * 86400)):
            with self.subTest(value=value):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                self.saved["verifiedAt"] = value
                await self.rejected("ARCHIVE_TIME_INVALID")
        self.document["archivedVerdict"] = original
        self.saved["verifiedAt"] = v.iso(HISTORICAL_TIME + 301)
        self.saved["expiresAt"] = v.iso(HISTORICAL_TIME + 421)
        await self.rejected("NVIDIA_TIME_INVALID")

    async def test_original_nonce_tls_signer_and_model_are_still_bound(self):
        original = copy.deepcopy(self.document)
        for field, value in (("nonce", "00" * 32), ("tlsSpkiSha256", "00" * 32)):
            with self.subTest(field=field):
                self.document = copy.deepcopy(original)
                self.document[field] = value
                await self.rejected()
        for field, value in (("signing_address", "0x" + "00" * 20), ("model_name", "wrong/model")):
            with self.subTest(field=field):
                self.document = copy.deepcopy(original)
                self.document["attestation"][field] = value
                await self.rejected()

    async def test_workload_actions_and_exact_policy_are_still_required(self):
        original_policy = copy.deepcopy(self.policy)
        self.policy["validUntil"] = v.iso(REPLAY_TIME)
        await self.rejected("POLICY_EXPIRED")
        self.policy = original_policy
        self.policy["profiles"][0]["gpuCount"] = 7
        await self.rejected("WORKLOAD_NOT_APPROVED")
        self.policy["profiles"][0]["gpuCount"] = PUBLIC["gpuCount"]
        manager = self.document["attestation"]["compose_manager_attestation"]
        manager["actions"][1]["file_sha256"] = "00" * 32
        manager["actions_hash"] = v.digest(v.canonical(manager["actions"]))
        manager["report_data"] = manager["actions_hash"] + self.document["nonce"]
        await self.rejected("WORKLOAD_BINDING_MISMATCH")

    def test_cli_direct_archive_is_explicit_and_mutually_exclusive(self):
        script = str(Path(v.__file__).with_name("verify.py"))
        help_result = subprocess.run([sys.executable, script, "--help"], capture_output=True, text=True, check=True)
        self.assertIn("--direct-archive", help_result.stdout)
        conflict = subprocess.run([sys.executable, script, "--policy", "unused.json", "--direct-archive", "--cloud"],
                                  capture_output=True, text=True, check=False)
        self.assertNotEqual(conflict.returncode, 0)
        self.assertIn("not allowed with argument", conflict.stderr)


if __name__ == "__main__":
    unittest.main()
