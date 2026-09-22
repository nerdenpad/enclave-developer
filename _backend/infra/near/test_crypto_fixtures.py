"""Offline replay of PUBLIC hardware evidence at its recorded validation time.

The time override and recorded JWKS are confined to tests. Production obtains
fresh Intel collateral and NVIDIA JWKS and uses the actual clock.
"""
import copy
import json
import unittest
from pathlib import Path

import dcap_qvl

from verifier import cpu_claims, verify_nvidia_tokens, VerificationError

FIXTURE = json.loads((Path(__file__).parent / "fixtures/glm-public-2026-09-19.json").read_text())


def collateral(values=None):
    values = values or FIXTURE["collateral"]
    return dcap_qvl.QuoteCollateralV3(**{
        key: bytes.fromhex(value["hex"]) if isinstance(value, dict) else value
        for key, value in values.items()
    })


class RealCryptographyTests(unittest.TestCase):
    def test_intel_signed_quote_chain_with_real_collateral(self):
        result = dcap_qvl.verify(bytes.fromhex(FIXTURE["quote"]), collateral(), FIXTURE["capturedAt"])
        claims = cpu_claims(json.loads(result.to_json()))
        self.assertEqual(claims["report_data"][64:], FIXTURE["nonce"])

    def test_modified_signed_quote_rejected_by_native_verifier(self):
        quote = bytearray.fromhex(FIXTURE["quote"])
        # Inside the quote's signed report, not merely an unauthenticated wrapper.
        quote[120] ^= 1
        with self.assertRaises(Exception):
            dcap_qvl.verify(bytes(quote), collateral(), FIXTURE["capturedAt"])

    def test_modified_intel_tcb_signature_rejected(self):
        data = copy.deepcopy(FIXTURE["collateral"])
        signature = bytearray.fromhex(data["tcb_info_signature"]["hex"])
        signature[0] ^= 1
        data["tcb_info_signature"]["hex"] = signature.hex()
        with self.assertRaises(Exception):
            dcap_qvl.verify(bytes.fromhex(FIXTURE["quote"]), collateral(data), FIXTURE["capturedAt"])

    def test_expired_collateral_rejected(self):
        with self.assertRaises(Exception):
            dcap_qvl.verify(bytes.fromhex(FIXTURE["quote"]), collateral(), FIXTURE["capturedAt"] + 366 * 86400)

    def test_real_nvidia_signed_gpu_and_aggregate_tokens(self):
        models, expiry = verify_nvidia_tokens(FIXTURE["nvidia"], FIXTURE["nvidiaJwks"],
            bytes.fromhex(FIXTURE["nonce"]), FIXTURE["gpuCount"], FIXTURE["nvidiaTime"])
        self.assertEqual(models, ["GH100"] * 8)
        self.assertGreater(expiry, FIXTURE["nvidiaTime"])

    def test_real_nvidia_tokens_cannot_be_replayed_for_new_nonce(self):
        with self.assertRaisesRegex(VerificationError, "NVIDIA_NONCE_INVALID"):
            verify_nvidia_tokens(FIXTURE["nvidia"], FIXTURE["nvidiaJwks"],
                bytes(32), FIXTURE["gpuCount"], FIXTURE["nvidiaTime"])


if __name__ == "__main__":
    unittest.main()
