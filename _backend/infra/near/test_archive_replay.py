"""Offline Cloud archive replay with genuine historical NVIDIA signatures.

The public fixture lacks complete gateway/compose-manager reports, so only CPU
quote retrieval is mocked in these integration tests. NVIDIA signatures, token
claims, workload bindings, policy authorization, and references execute normally.
The HTTP guard permits the fixed trusted JWKS GET and rejects any replay POST.
"""
import base64
import copy
import json
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import verifier as v


PUBLIC = json.loads((Path(__file__).parent / "fixtures/glm-public-2026-09-19.json")
                    .read_text(encoding="utf-8"))
HISTORICAL_TIME = PUBLIC["nvidiaTime"]
REPLAY_TIME = HISTORICAL_TIME + 11 * 86400
MODEL = "archive/example-model"
GATEWAY_SPKI = "34" * 32
MODEL_SPKI = "56" * 32
GATEWAY_SIGNER = "0x" + "78" * 20
MODEL_SIGNER = "0x" + "9a" * 20


def archive_fixture():
    nonce = PUBLIC["nonce"]
    event = {"imr": 3, "event_type": 7, "event": "reviewed-workload",
             "event_payload": "abcd", "digest": ""}
    runtime_measurement = v.replay_rtmr3([event])
    cpu_results = {}

    def measured_report(compose, quote, signer, spki):
        app_hash = v.digest(compose.encode("utf-8"))
        measures = {key: "00" * size for key, size in v.MEASUREMENTS.items()}
        measures["mr_config_id"] = "01" + app_hash + "00" * 15
        measures["rt_mr3"] = runtime_measurement
        report_data = v.digest(bytes.fromhex(signer[2:] + spki)) + nonce
        cpu_results[quote] = {"status": "UpToDate", "advisory_ids": [],
            "qe_status": {"status": "UpToDate", "advisory_ids": []},
            "platform_status": {"status": "UpToDate", "advisory_ids": []},
            "report": {"TD10": {**measures, "report_data": report_data}},
            "ppid": "bc" * 16}
        return measures, app_hash, report_data

    gateway_quote = "aa" * 600
    gateway_compose = '{"service":"reviewed-gateway"}'
    gateway_measures, gateway_hash, gateway_report_data = measured_report(
        gateway_compose, gateway_quote, GATEWAY_SIGNER, GATEWAY_SPKI)
    gateway = {"request_nonce": nonce, "signing_algo": "ecdsa",
        "signing_address": GATEWAY_SIGNER, "tls_cert_fingerprint": GATEWAY_SPKI,
        "intel_quote": gateway_quote, "report_data": gateway_report_data,
        "event_log": [event], "info": {"tcb_info": {"app_compose": gateway_compose}}}

    model_quote, manager_quote = "model-quote", "manager-quote"
    model_compose = '{"service":"reviewed-model"}'
    measures, app_hash, _ = measured_report(
        model_compose, model_quote, MODEL_SIGNER, MODEL_SPKI)
    manager_image = "nearaidev/compose-manager@sha256:" + "de" * 32
    actions = [{"action": "compose_manager_started", "image": manager_image},
               {"action": "compose_up", "file_sha256": "ef" * 32,
                "services": ["model"]}]
    actions_hash = v.digest(v.canonical(actions))
    cpu_results[manager_quote] = copy.deepcopy(cpu_results[model_quote])
    cpu_results[manager_quote]["report"]["TD10"]["report_data"] = actions_hash + nonce
    model = {"request_nonce": nonce, "signing_algo": "ecdsa",
        "signing_address": MODEL_SIGNER, "tls_cert_fingerprint": MODEL_SPKI,
        "model_name": MODEL, "intel_quote": model_quote, "event_log": [event],
        "info": {"tcb_info": {"app_compose": model_compose}},
        "nvidia_payload": {"nonce": nonce, "arch": "HOPPER", "evidence_list": [
            {"certificate": "public-fixture-certificate", "evidence": "public-fixture-report"}
            for _ in range(PUBLIC["gpuCount"])]},
        "compose_manager_attestation": {"quote": manager_quote, "actions": actions,
            "actions_hash": actions_hash, "nonce": nonce, "nonce_source": "client",
            "report_data": actions_hash + nonce}}
    document = {"nonce": nonce, "tlsSpkiSha256": GATEWAY_SPKI, "model": MODEL,
                "attestation": {"gateway_attestation": gateway,
                                "model_attestations": [model]}}
    policy = {"schemaVersion": 1, "version": "reviewed-archive-fixture-1",
        "validFrom": v.iso(HISTORICAL_TIME - 60), "validUntil": v.iso(REPLAY_TIME + 600),
        "maxSessionSeconds": 120,
        "gatewayProfiles": [{"appComposeSha256": gateway_hash,
                             "measurements": gateway_measures}],
        "profiles": [{"model": MODEL, "measurements": measures,
            "appComposeSha256": app_hash, "composeManagerActionsSha256": actions_hash,
            "composeManagerImage": manager_image, "gpuCount": PUBLIC["gpuCount"],
            "gpuModels": ["GH100"]}]}
    return document, policy, cpu_results


class ArchiveReplayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.document, self.policy, self.cpu_results = archive_fixture()
        self.allow_attestation_post = True
        self.http_calls = []

        def offline_http(method, url, payload=None):
            self.http_calls.append((method, url))
            if method == "GET" and url == v.NRAS_ORIGIN + "/.well-known/jwks.json":
                return copy.deepcopy(PUBLIC["nvidiaJwks"])
            if (self.allow_attestation_post and method == "POST"
                    and url == v.NRAS_ORIGIN + "/v3/attest/gpu"):
                return copy.deepcopy(PUBLIC["nvidia"])
            raise AssertionError("Archive replay attempted an unexpected network request")

        self.quote_mock = patch.object(v, "verify_tdx", new=AsyncMock(
            side_effect=lambda quote: copy.deepcopy(self.cpu_results[quote])))
        self.http_mock = patch.object(v, "http_json", side_effect=offline_http)
        self.clock_mock = patch.object(v.time, "time", return_value=HISTORICAL_TIME)
        self.quote_mock.start()
        self.http_mock.start()
        self.clock = self.clock_mock.start()
        self.addCleanup(self.quote_mock.stop)
        self.addCleanup(self.http_mock.stop)
        self.addCleanup(self.clock_mock.stop)
        self.document["archivedVerdict"] = await v.verify_cloud(self.document, self.policy)
        self.allow_attestation_post = False
        self.http_calls.clear()
        self.clock.return_value = REPLAY_TIME

    @property
    def saved(self):
        return self.document["archivedVerdict"]

    def rebind_references(self):
        """Rebuild unauthenticated cache hashes after tampering with saved JWTs."""
        for candidate, verdict in zip(self.document["attestation"]["model_attestations"],
                                      self.saved["modelVerdicts"], strict=True):
            verdict["nvidiaEvidenceSha256"] = v.digest(v.canonical(verdict["nvidiaEvidence"]))
            child_input = {"nonce": self.document["nonce"],
                           "tlsSpkiSha256": candidate["tls_cert_fingerprint"],
                           "attestation": candidate}
            verdict["attestationRef"] = "0x" + v.digest(v.canonical({
                "input": child_input, "policy": self.policy,
                "nvidiaEvidenceSha256": verdict["nvidiaEvidenceSha256"]}))
        self.saved["attestationRef"] = "0x" + v.digest(v.canonical({
            "gatewayRef": self.saved["gatewayVerdict"]["attestationRef"],
            "modelRefs": [item["attestationRef"] for item in self.saved["modelVerdicts"]],
            "model": self.document["model"]}))

    async def rejected(self, *codes):
        with self.assertRaises(v.VerificationError) as caught:
            await v.verify_cloud_archive(self.document, self.policy)
        if codes:
            self.assertIn(caught.exception.code, codes)

    async def test_real_historical_tokens_replay_after_live_session_expired(self):
        self.assertLess(v.timestamp(self.saved["expiresAt"]), REPLAY_TIME)
        result = await v.verify_cloud_archive(self.document, self.policy)
        self.assertTrue(result["ok"])
        self.assertTrue(result["archivedHardwareVerified"])
        self.assertEqual(result["replayedAt"], v.iso(REPLAY_TIME))
        self.assertEqual(result["verifiedAt"], v.iso(HISTORICAL_TIME))
        self.assertEqual(result["allowedSigners"], [MODEL_SIGNER])
        self.assertEqual(result["modelVerdicts"][0]["gpuCount"], 8)
        self.assertEqual(result["modelVerdicts"][0]["nvidiaEvidence"], PUBLIC["nvidia"])
        self.assertEqual(result["attestationRef"], self.saved["attestationRef"])
        self.assertLess(v.timestamp(result["expiresAt"]), REPLAY_TIME)
        self.assertTrue(self.http_calls)
        self.assertTrue(all(call == ("GET", v.NRAS_ORIGIN + "/.well-known/jwks.json")
                            for call in self.http_calls))

    async def test_archive_requires_enriched_gateway_and_model_verdicts(self):
        original = copy.deepcopy(self.saved)
        for key in ("gatewayVerdict", "modelVerdicts"):
            with self.subTest(key=key):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                self.saved.pop(key)
                await self.rejected("ARCHIVE_INVALID")

    async def test_live_cloud_cannot_consume_archived_verdict(self):
        with self.assertRaisesRegex(v.VerificationError, "INPUT_INVALID"):
            await v.verify_cloud(self.document, self.policy)
        self.assertEqual(self.http_calls, [])

    async def test_duplicated_candidates_and_cached_verdicts_rejected(self):
        candidates = self.document["attestation"]["model_attestations"]
        candidates.append(copy.deepcopy(candidates[0]))
        self.saved["modelVerdicts"].append(copy.deepcopy(self.saved["modelVerdicts"][0]))
        await self.rejected("MODEL_EVIDENCE_DUPLICATE")

    async def test_modified_aggregate_signature_rejected_even_with_rebound_cache_hashes(self):
        bundle = self.saved["modelVerdicts"][0]["nvidiaEvidence"]
        parts = bundle[0][1].split(".")
        signature = bytearray(base64.urlsafe_b64decode(parts[2] + "=" * (-len(parts[2]) % 4)))
        signature[0] ^= 1
        parts[2] = base64.urlsafe_b64encode(signature).decode("ascii").rstrip("=")
        bundle[0][1] = ".".join(parts)
        self.rebind_references()
        await self.rejected("NVIDIA_SIGNATURE_INVALID")

    async def test_modified_signed_claim_rejected_even_with_rebound_cache_hashes(self):
        bundle = self.saved["modelVerdicts"][0]["nvidiaEvidence"]
        parts = bundle[0][1].split(".")
        claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
        claims["eat_nonce"] = "00" * 32
        parts[1] = base64.urlsafe_b64encode(v.canonical(claims)).decode("ascii").rstrip("=")
        bundle[0][1] = ".".join(parts)
        self.rebind_references()
        await self.rejected("NVIDIA_SIGNATURE_INVALID")

    async def test_modified_device_jwt_rejected_by_signed_aggregate_binding(self):
        bundle = self.saved["modelVerdicts"][0]["nvidiaEvidence"]
        bundle[1]["GPU-0"] = bundle[1]["GPU-1"]
        self.rebind_references()
        await self.rejected("NVIDIA_GPU_BINDING_INVALID")

    async def test_archived_keys_cannot_replace_trusted_jwks(self):
        self.saved["nvidiaJwks"] = PUBLIC["nvidiaJwks"]
        with patch.object(v, "http_json", return_value={"keys": []}):
            await self.rejected("NVIDIA_SIGNATURE_INVALID")

    async def test_missing_archived_nvidia_evidence_rejected(self):
        self.saved["modelVerdicts"][0].pop("nvidiaEvidence")
        await self.rejected("ARCHIVE_INVALID")

    async def test_saved_reference_and_evidence_digest_tampering_rejected(self):
        original = copy.deepcopy(self.saved)
        for location, key in (("cloud", "attestationRef"), ("gateway", "attestationRef"),
                              ("model", "attestationRef"), ("model", "nvidiaEvidenceSha256")):
            with self.subTest(location=location, key=key):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                target = self.saved if location == "cloud" else (
                    self.saved["gatewayVerdict"] if location == "gateway"
                    else self.saved["modelVerdicts"][0])
                target[key] = ("0x" if key == "attestationRef" else "") + "00" * 32
                await self.rejected("ARCHIVE_VERDICT_MISMATCH")

    async def test_invalid_future_or_over_horizon_archive_time_rejected(self):
        original = copy.deepcopy(self.saved)
        for value in ("not-a-timestamp", v.iso(REPLAY_TIME + 1),
                      v.iso(REPLAY_TIME - 31 * 86400)):
            with self.subTest(value=value):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                self.saved["verifiedAt"] = value
                await self.rejected("ARCHIVE_TIME_INVALID")

    async def test_child_time_cannot_follow_cloud_time_or_precede_session_window(self):
        original = copy.deepcopy(self.saved)
        for value in (v.iso(HISTORICAL_TIME + 1), v.iso(HISTORICAL_TIME - 121)):
            with self.subTest(value=value):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                self.saved["modelVerdicts"][0]["verifiedAt"] = value
                await self.rejected("ARCHIVE_TIME_INVALID", "NVIDIA_TIME_INVALID")

    async def test_coherent_timestamp_shift_cannot_exceed_signed_token_freshness_window(self):
        # Even matching duration/chronology/cache fields cannot make signed JWTs
        # validate outside their original 300-second issuance window.
        for verdict in (self.saved, self.saved["gatewayVerdict"], *self.saved["modelVerdicts"]):
            for key in ("verifiedAt", "expiresAt"):
                verdict[key] = v.iso(v.timestamp(verdict[key]) + 301)
        await self.rejected("NVIDIA_TIME_INVALID")

    async def test_cached_expiry_cannot_extend_verified_session(self):
        original = copy.deepcopy(self.saved)
        for location in ("cloud", "gateway", "model"):
            with self.subTest(location=location):
                self.document["archivedVerdict"] = copy.deepcopy(original)
                target = self.saved if location == "cloud" else (
                    self.saved["gatewayVerdict"] if location == "gateway"
                    else self.saved["modelVerdicts"][0])
                target["expiresAt"] = v.iso(HISTORICAL_TIME + 121)
                await self.rejected("ARCHIVE_VERDICT_MISMATCH", "ARCHIVE_TIME_INVALID")

    async def test_modified_nonce_tls_and_requested_model_rejected(self):
        original_document = copy.deepcopy(self.document)
        for key, value in (("nonce", "00" * 32), ("tlsSpkiSha256", "00" * 32),
                           ("model", "unreviewed/model")):
            with self.subTest(key=key):
                self.document = copy.deepcopy(original_document)
                self.document[key] = value
                await self.rejected()

    async def test_modified_workload_actions_still_require_cpu_binding(self):
        manager = self.document["attestation"]["model_attestations"][0]["compose_manager_attestation"]
        manager["actions"][1]["file_sha256"] = "00" * 32
        manager["actions_hash"] = v.digest(v.canonical(manager["actions"]))
        manager["report_data"] = manager["actions_hash"] + self.document["nonce"]
        await self.rejected("WORKLOAD_BINDING_MISMATCH")

    async def test_current_policy_must_remain_active_and_authorize_complete_workload(self):
        original = copy.deepcopy(self.policy)
        for edit, error in ((lambda p: p.update(validUntil=v.iso(REPLAY_TIME)), "POLICY_EXPIRED"),
                            (lambda p: p["profiles"][0].update(gpuCount=7), "WORKLOAD_NOT_APPROVED"),
                            (lambda p: p["gatewayProfiles"][0]["measurements"].update(mr_td="ff" * 48),
                             "GATEWAY_POLICY_MISMATCH")):
            with self.subTest(error=error):
                self.policy = copy.deepcopy(original)
                edit(self.policy)
                await self.rejected(error, "ARCHIVE_VERDICT_MISMATCH")

    async def test_untrusted_cached_allowed_signers_cannot_grant_new_signer(self):
        self.saved["allowedSigners"].append("0x" + "ff" * 20)
        await self.rejected("ARCHIVE_VERDICT_MISMATCH")


if __name__ == "__main__":
    unittest.main()
