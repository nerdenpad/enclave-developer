"""Create an EXPIRED review candidate, never an automatically authorized policy."""
import argparse
import asyncio
import json
from pathlib import Path

from probe import probe
from verifier import VerificationError, inspect_evidence


async def candidate(host):
    evidence = await asyncio.to_thread(probe, host)
    facts = await inspect_evidence(evidence)
    fields = ("model", "appComposeSha256", "measurements", "composeManagerActionsSha256", "composeManagerImage", "gpuCount", "gpuModels")
    return {
        "schemaVersion": 1, "version": "REVIEW-REQUIRED",
        "validFrom": "1970-01-01T00:00:00Z", "validUntil": "1970-01-01T00:00:01Z",
        "maxSessionSeconds": 120, "profiles": [{key: facts[key] for key in fields}],
        "provenance": {"status": "REVIEW_REQUIRED", "observedHost": host,
                       "instructions": "Audit base compose and EVERY runtime action, reproduce official file hashes and review immutable images before choosing a version and validity interval. This candidate is expired and cannot authorize inference."},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("host")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        result = asyncio.run(candidate(args.host))
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        # Exclusive creation prevents an accidental candidate refresh from replacing
        # a reviewed production policy currently used by an API process.
        with Path(args.output).open("x", encoding="utf-8") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
        print(json.dumps({"candidateSaved": True, "authorized": False}))
        return 0
    except VerificationError as error:
        print(json.dumps({"candidateSaved": False, "error": error.code}))
    except Exception:
        print(json.dumps({"candidateSaved": False, "error": "CANDIDATE_FAILED"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
