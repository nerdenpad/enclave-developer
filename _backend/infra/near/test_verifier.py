"""Negative enforcement tests with actual EC JWT signatures; no network or GPU."""
import asyncio
import copy
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import jwt
from cryptography.hazmat.primitives.asymmetric import ec

import verifier as v

NOW = int(time.time())
NONCE = "12" * 32
SPKI = "34" * 32
SIGNER = "0x" + "56" * 20
PRIVATE_KEY = ec.generate_private_key(ec.SECP384R1())
WRONG_KEY = ec.generate_private_key(ec.SECP384R1())
PUBLIC_JWK = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(PRIVATE_KEY.public_key()))
PUBLIC_JWK.update(kid="test-key", alg="ES384", use="sig")
JWKS = {"keys": [PUBLIC_JWK]}


def token(claims, key=PRIVATE_KEY, **headers):
    return jwt.encode(claims, key, algorithm="ES384", headers={"kid": "test-key", **headers})


def base_claims():
    return {"iss": v.NRAS_ORIGIN, "iat": NOW, "nbf": NOW, "exp": NOW + 3600, "eat_nonce": NONCE}


def gpu_bundle(device_updates=None, overall_updates=None, device_key=PRIVATE_KEY):
    device = {**base_claims(), **{key: True for key in v.GPU_TRUE_CLAIMS},
              "measres": "success", "dbgstat": "disabled", "hwmodel": "GH100", "ueid": "gpu-1",
              "x-nvidia-attestation-warning": None, **(device_updates or {})}
    encoded = token(device, device_key)
    overall = {**base_claims(), "x-nvidia-ver": "2.0", "x-nvidia-overall-att-result": True,
               "submods": {"GPU-0": ["DIGEST", ["SHA-256", v.digest(encoded.encode())]]},
               **(overall_updates or {})}
    return [["JWT", token(overall)], {"GPU-0": encoded}]


def fixture():
    compose = '{"immutable":"reviewed"}'
    app_hash = v.digest(compose.encode())
    measures = {key: "00" * size for key, size in v.MEASUREMENTS.items()}
    measures["mr_config_id"] = "01" + app_hash + "00" * 15
    actions = [{"action": "compose_manager_started", "image": "nearaidev/compose-manager@sha256:" + "89" * 32},
               {"timestamp": "2026-09-19T12:00:00Z", "action": "compose_up", "file_sha256": "ab" * 32,
                "services": ["model"]}]
    actions_hash = v.digest(v.canonical(actions))
    td = {**measures, "report_data": v.digest(bytes.fromhex(SIGNER[2:] + SPKI)) + NONCE}
    cpu = {"status": "UpToDate", "advisory_ids": [], "report": {"TD10": td}, "ppid": "78" * 16,
           "qe_status": {"status": "UpToDate", "advisory_ids": []},
           "platform_status": {"status": "UpToDate", "advisory_ids": []}}
    manager_cpu = copy.deepcopy(cpu)
    manager_cpu["report"]["TD10"]["report_data"] = actions_hash + NONCE
    doc = {"nonce": NONCE, "tlsSpkiSha256": SPKI, "attestation": {
        "request_nonce": NONCE, "signing_algo": "ecdsa", "signing_address": SIGNER,
        "tls_cert_fingerprint": SPKI, "model_name": "example/model", "intel_quote": "main",
        "info": {"tcb_info": {"app_compose": compose}},
        "nvidia_payload": json.dumps({"nonce": NONCE, "arch": "HOPPER", "evidence_list": [{"certificate": "cert", "evidence": "report"}]}),
        "compose_manager_attestation": {"quote": "manager", "actions": actions, "actions_hash": actions_hash,
            "nonce": NONCE, "nonce_source": "client", "report_data": actions_hash + NONCE},
    }}
    profile = {"model": "example/model", "measurements": measures,
               "appComposeSha256": app_hash, "composeManagerActionsSha256": actions_hash,
               "composeManagerImage": actions[0]["image"],
               "gpuCount": 1, "gpuModels": ["GH100"]}
    policy = {"schemaVersion": 1, "version": "reviewed-1", "validFrom": v.iso(NOW - 60),
              "validUntil": v.iso(NOW + 600), "maxSessionSeconds": 120, "profiles": [profile]}
    return doc, policy, cpu, manager_cpu


class VerifierTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.doc, self.policy, self.cpu, self.manager_cpu = fixture()
        self.bundle = gpu_bundle()
        self.quote_mock = patch.object(v, "verify_tdx", new=AsyncMock(side_effect=lambda quote: copy.deepcopy(
            self.cpu if quote == "main" else self.manager_cpu)))
        self.http_mock = patch.object(v, "http_json", side_effect=lambda method, *_: copy.deepcopy(self.bundle if method == "POST" else JWKS))
        self.time_mock = patch.object(v.time, "time", return_value=NOW)
        self.quote_mock.start(); self.http_mock.start(); self.time_mock.start()
        self.addCleanup(self.quote_mock.stop); self.addCleanup(self.http_mock.stop); self.addCleanup(self.time_mock.stop)

    async def rejected(self, code=None):
        with self.assertRaises(v.VerificationError) as error:
            await v.verify(self.doc, self.policy)
        if code:
            self.assertEqual(error.exception.code, code)

    async def test_verified_session_has_short_expiry_and_evidence_reference(self):
        result = await v.verify(self.doc, self.policy)
        self.assertTrue(result["ok"])
        self.assertEqual(result["signingAddress"], SIGNER)
        self.assertEqual(result["tlsSpkiSha256"], SPKI)
        self.assertEqual(result["expiresAt"], v.iso(NOW + 120))
        self.assertRegex(result["attestationRef"], r"^0x[0-9a-f]{64}$")

    async def test_session_never_outlives_policy(self):
        self.policy["validUntil"] = v.iso(NOW + 10)
        self.assertEqual((await v.verify(self.doc, self.policy))["expiresAt"], v.iso(NOW + 10))

    async def test_nonce_and_tls_and_signer_tampering_rejected(self):
        mutations = [("request_nonce", "01" * 32, "NONCE_MISMATCH"),
                     ("tls_cert_fingerprint", "01" * 32, "TLS_BINDING_MISMATCH"),
                     ("signing_address", "0x" + "01" * 20, "CPU_BINDING_MISMATCH")]
        for key, value, error in mutations:
            with self.subTest(key=key):
                old = self.doc["attestation"][key]
                self.doc["attestation"][key] = value
                await self.rejected(error)
                self.doc["attestation"][key] = old

    async def test_unknown_signing_algorithm_rejected(self):
        self.doc["attestation"]["signing_algo"] = "ed25519"
        await self.rejected("SIGNING_ALGORITHM_REJECTED")

    async def test_old_tcb_or_advisories_even_with_valid_signature_rejected(self):
        for target in [self.cpu, self.manager_cpu, self.cpu["qe_status"], self.cpu["platform_status"]]:
            with self.subTest(target=target):
                target["status"] = "OutOfDate"
                await self.rejected("CPU_TCB_REJECTED")
                target["status"] = "UpToDate"
                target["advisory_ids"] = ["INTEL-SA-example"]
                await self.rejected("CPU_TCB_REJECTED")
                target["advisory_ids"] = []

    async def test_debug_tdx_rejected(self):
        self.cpu["report"]["TD10"]["td_attributes"] = "0100000000000000"
        await self.rejected("CPU_DEBUG_REJECTED")

    async def test_non_tdx_and_unknown_report_formats_rejected(self):
        self.cpu["report"] = {"SGX": {}}
        await self.rejected("CPU_TYPE_REJECTED")

    async def test_manager_quote_from_another_vm_or_chip_rejected(self):
        self.manager_cpu["ppid"] = "00" * 16
        await self.rejected("WORKLOAD_VM_MISMATCH")
        self.manager_cpu["ppid"] = self.cpu["ppid"]
        self.manager_cpu["report"]["TD10"]["rt_mr3"] = "01" * 48
        await self.rejected("WORKLOAD_VM_MISMATCH")

    async def test_unmeasured_or_tampered_runtime_actions_rejected(self):
        cm = self.doc["attestation"]["compose_manager_attestation"]
        cm["actions"][0]["file_sha256"] = "00" * 32
        # Recomputing unauthenticated claims cannot change the Intel-signed quote.
        cm["actions_hash"] = v.digest(v.canonical(cm["actions"]))
        cm["report_data"] = cm["actions_hash"] + NONCE
        await self.rejected("WORKLOAD_BINDING_MISMATCH")

    async def test_manager_quote_with_old_nonce_rejected(self):
        self.manager_cpu["report"]["TD10"]["report_data"] = "01" * 64
        await self.rejected("WORKLOAD_BINDING_MISMATCH")

    async def test_manager_image_change_requires_explicit_review(self):
        self.policy["profiles"][0]["composeManagerImage"] = "nearaidev/compose-manager@sha256:" + "aa" * 32
        await self.rejected("WORKLOAD_NOT_APPROVED")

    async def test_unknown_or_mutable_manager_image_rejected(self):
        self.doc["attestation"]["compose_manager_attestation"]["actions"][0]["image"] = "nearaidev/compose-manager:latest"
        await self.rejected("WORKLOAD_MANAGER_UNKNOWN")

    async def test_manager_missing_or_server_chosen_nonce_rejected(self):
        self.doc["attestation"]["compose_manager_attestation"]["nonce_source"] = "server"
        await self.rejected("WORKLOAD_NONCE_MISMATCH")
        del self.doc["attestation"]["compose_manager_attestation"]
        await self.rejected("WORKLOAD_EVIDENCE_MISSING")

    async def test_compose_hash_covers_entire_config_field(self):
        self.doc["attestation"]["info"]["tcb_info"]["app_compose"] += " "
        await self.rejected("WORKLOAD_COMPOSE_MISMATCH")

    async def test_string_tcb_info_is_supported(self):
        info = self.doc["attestation"]["info"]
        info["tcb_info"] = json.dumps(info["tcb_info"])
        self.assertTrue((await v.verify(self.doc, self.policy))["ok"])

    async def test_no_cross_product_between_allowed_profiles(self):
        self.policy["profiles"].append(copy.deepcopy(self.policy["profiles"][0]))
        self.policy["profiles"][0]["composeManagerActionsSha256"] = "00" * 32
        self.policy["profiles"][1]["measurements"]["rt_mr3"] = "01" * 48
        await self.rejected("WORKLOAD_NOT_APPROVED")

    async def test_both_reviewed_glm_profiles_are_allowed_only_as_complete_profiles(self):
        policy = json.loads((Path(__file__).parent / "policy.glm-2026-09-19.json").read_text(encoding="utf-8"))
        # Test authorization independently of the intentionally expiring rollout.
        policy["validFrom"], policy["validUntil"] = v.iso(NOW - 1), v.iso(NOW + 600)
        self.assertEqual(len(policy["profiles"]), 2)
        for profile in policy["profiles"]:
            facts = {**copy.deepcopy(profile), "signingAddress": SIGNER, "tlsSpkiSha256": SPKI,
                     "cpuStatus": "UpToDate", "nvidiaExpiresAt": NOW + 600,
                     "nvidiaEvidenceSha256": "ab" * 32, "nvidiaEvidence": []}
            with patch.object(v, "inspect_evidence", new=AsyncMock(return_value=facts)):
                result = await v.verify(self.doc, policy)
                self.assertTrue(result["ok"])
                self.assertEqual(result["measurements"], profile["measurements"])
        # Authentic individual values from separate approved VMs cannot form
        # an approved synthetic workload.
        hybrid = {**facts, "composeManagerActionsSha256": policy["profiles"][0]["composeManagerActionsSha256"]}
        with patch.object(v, "inspect_evidence", new=AsyncMock(return_value=hybrid)):
            with self.assertRaisesRegex(v.VerificationError, "WORKLOAD_NOT_APPROVED"):
                await v.verify(self.doc, policy)

    async def test_gpu_count_or_model_policy_mismatch(self):
        self.policy["profiles"][0]["gpuCount"] = 2
        await self.rejected("WORKLOAD_NOT_APPROVED")
        self.policy["profiles"][0]["gpuCount"] = 1
        self.policy["profiles"][0]["gpuModels"] = ["GB100"]
        await self.rejected("WORKLOAD_NOT_APPROVED")

    async def test_policy_expiry_missing_version_and_incomplete_measurements(self):
        self.policy["validUntil"] = v.iso(NOW)
        await self.rejected("POLICY_EXPIRED")
        self.policy["validUntil"] = v.iso(NOW + 600)
        del self.policy["version"]
        await self.rejected("POLICY_INVALID")
        self.policy["version"] = "v1"
        del self.policy["profiles"][0]["measurements"]["rt_mr3"]
        await self.rejected("POLICY_INVALID")

    async def test_nras_outage_cannot_produce_pass(self):
        with patch.object(v, "http_json", side_effect=v.VerificationError("NVIDIA_UNAVAILABLE")):
            await self.rejected("NVIDIA_UNAVAILABLE")

    async def test_gpu_evidence_nonce_mismatch_rejected_before_nras(self):
        payload = json.loads(self.doc["attestation"]["nvidia_payload"])
        payload["nonce"] = "00" * 32
        self.doc["attestation"]["nvidia_payload"] = payload
        await self.rejected("NVIDIA_NONCE_INVALID")


class NvidiaTests(unittest.TestCase):
    def verify(self, bundle, jwks=JWKS):
        return v.verify_nvidia_tokens(bundle, jwks, bytes.fromhex(NONCE), 1, NOW)

    def test_actual_es384_signature_accepted(self):
        self.assertEqual(self.verify(gpu_bundle()), (["GH100"], NOW + 3600))

    def test_forged_overall_and_device_signatures_rejected(self):
        bundle = gpu_bundle(device_key=WRONG_KEY)
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_SIGNATURE_INVALID"):
            self.verify(bundle)
        bundle = gpu_bundle()
        claims = jwt.decode(bundle[0][1], options={"verify_signature": False})
        bundle[0][1] = token(claims, WRONG_KEY)
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_SIGNATURE_INVALID"):
            self.verify(bundle)

    def test_overall_true_cannot_hide_failed_device_claims(self):
        for updates in [{"measres": "failure"}, {"dbgstat": "enabled"}, {"secboot": False},
                        {"x-nvidia-gpu-attestation-report-signature-verified": False},
                        {"x-nvidia-attestation-warning": "warning"}]:
            with self.subTest(updates=updates), self.assertRaisesRegex(v.VerificationError, "NVIDIA_GPU_REJECTED"):
                self.verify(gpu_bundle(device_updates=updates))

    def test_nonce_expiry_future_and_old_iat_rejected(self):
        for updates in [{"eat_nonce": "00" * 32}, {"exp": NOW}, {"iat": NOW + 20},
                        {"nbf": NOW + 20}, {"iat": NOW - 301}]:
            with self.subTest(updates=updates), self.assertRaises(v.VerificationError):
                self.verify(gpu_bundle(device_updates=updates))

    def test_overall_false_and_string_true_rejected(self):
        for value in [False, "true", 1]:
            with self.subTest(value=value), self.assertRaisesRegex(v.VerificationError, "NVIDIA_RESULT_REJECTED"):
                self.verify(gpu_bundle(overall_updates={"x-nvidia-overall-att-result": value}))

    def test_missing_or_swapped_device_tokens_rejected(self):
        bundle = gpu_bundle()
        bundle[1]["GPU-0"] = gpu_bundle(device_updates={"ueid": "other"})[1]["GPU-0"]
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_GPU_BINDING_INVALID"):
            self.verify(bundle)
        bundle[1] = {}
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_GPU_SET_INVALID"):
            self.verify(bundle)

    def test_no_attacker_jwks_url_or_unknown_key(self):
        bundle = gpu_bundle()
        claims = jwt.decode(bundle[0][1], options={"verify_signature": False})
        bundle[0][1] = token(claims, jku="https://attacker.invalid/keys")
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_SIGNATURE_INVALID"):
            self.verify(bundle)
        with self.assertRaisesRegex(v.VerificationError, "NVIDIA_SIGNATURE_INVALID"):
            self.verify(gpu_bundle(), {"keys": []})


class BoundaryTests(unittest.TestCase):
    def test_review_snapshot_matches_development_policy(self):
        folder = Path(__file__).parent
        policy = json.loads((folder / "policy.glm-2026-09-19.json").read_text(encoding="utf-8"))
        for profile, filename in zip(policy["profiles"], ["glm-2026-09-19.json", "glm-gpu03-2026-09-19.json"], strict=True):
            snapshot = json.loads((folder / "provenance" / filename).read_text(encoding="utf-8"))
            self.assertEqual(profile["appComposeSha256"], v.digest(snapshot["appCompose"].encode("utf-8")))
            self.assertEqual(profile["composeManagerActionsSha256"], v.digest(v.canonical(snapshot["composeManagerActions"])))
            self.assertEqual(profile["composeManagerImage"], snapshot["composeManagerImage"])
        self.assertLessEqual(v.timestamp(policy["validUntil"]) - v.timestamp(policy["validFrom"]), 7 * 86400 + 60)

    def test_gpu03_review_candidate_remains_expired(self):
        candidate = json.loads((Path(__file__).parent / "policy.gpu03.candidate.json").read_text(encoding="utf-8"))
        with self.assertRaisesRegex(v.VerificationError, "POLICY_EXPIRED"):
            v.validate_policy(candidate, NOW)

    def test_duplicate_json_keys_and_nan_rejected(self):
        for value in ['{"nonce":"a","nonce":"b"}', '{"value":NaN}']:
            with self.assertRaises(v.VerificationError):
                v.parse_json(value)

    def test_error_output_never_echoes_input(self):
        with tempfile.TemporaryDirectory() as folder:
            policy = Path(folder) / "policy.json"
            policy.write_text("{}")
            result = subprocess.run([sys.executable, str(Path(__file__).with_name("verify.py")), "--policy", str(policy)],
                                    input='{"credential":"DO-NOT-ECHO",broken', text=True, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout), {"ok": False, "error": "INPUT_INVALID"})
            self.assertNotIn("DO-NOT-ECHO", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
