"""Fetch public attestation on the same CA-verified connection as the peer SPKI."""
import argparse
import hashlib
import http.client
import json
import re
import secrets
import ssl
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from verifier import MAX_DOCUMENT_BYTES, VerificationError, parse_json, require


def probe(host):
    require(isinstance(host, str) and re.fullmatch(r"[a-z0-9-]+\.completions\.near\.ai", host), "HOST_INVALID")
    nonce = secrets.token_hex(32)
    connection = http.client.HTTPSConnection(host, context=ssl.create_default_context(), timeout=40)
    try:
        connection.connect()
        certificate = x509.load_der_x509_certificate(connection.sock.getpeercert(binary_form=True))
        spki = certificate.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
        connection.request("GET", "/v1/attestation/report?include_tls_fingerprint=true&signing_algo=ecdsa&nonce=" + nonce)
        response = connection.getresponse()
        require(response.status == 200, "ATTESTATION_UNAVAILABLE")
        raw = response.read(MAX_DOCUMENT_BYTES + 1)
        require(len(raw) <= MAX_DOCUMENT_BYTES, "INPUT_INVALID")
        return {"attestation": parse_json(raw), "nonce": nonce,
                "tlsSpkiSha256": hashlib.sha256(spki).hexdigest()}
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        document = probe(args.host)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(document, indent=2), encoding="utf-8")
        print(json.dumps({"saved": True, "verified": False}))
        return 0
    except Exception:
        print(json.dumps({"saved": False, "error": "PUBLIC_PROBE_FAILED"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
