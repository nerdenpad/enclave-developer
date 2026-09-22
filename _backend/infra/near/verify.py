"""Fail-closed subprocess boundary. stdin contains public evidence, never API keys."""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from verifier import MAX_DOCUMENT_BYTES, VerificationError, parse_json, verify


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--policy", required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(MAX_DOCUMENT_BYTES + 1)
        if len(raw) > MAX_DOCUMENT_BYTES:
            raise VerificationError("INPUT_INVALID")
        with Path(args.policy).open("rb") as source:
            policy = source.read(MAX_DOCUMENT_BYTES + 1)
        if len(policy) > MAX_DOCUMENT_BYTES:
            raise VerificationError("POLICY_INVALID")
        result = asyncio.run(verify(parse_json(raw), parse_json(policy)))
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except VerificationError as error:
        print(json.dumps({"ok": False, "error": error.code}))
    except Exception:
        # Native DCAP/HTTP exceptions can contain evidence, addresses, and headers.
        print(json.dumps({"ok": False, "error": "VERIFICATION_FAILED"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
