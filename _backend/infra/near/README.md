# NEAR hardware evidence verifier

This subprocess verifies NEAR's direct-model and Cloud Gateway ECDSA + TLS SPKI
report formats before the API sends a prompt. It does not call inference, load `.env`
files, access API keys, deploy workloads, or trust an upstream `PASS` string.

## Install and test

Python 3.10+ with a platform supported by `dcap-qvl` is required. Python 3.13 on
Windows was tested. Create an isolated environment rather than modifying system
Python:

```powershell
py -3.13 -m venv infra/near/.venv
infra/near/.venv/Scripts/python.exe -m pip install -r infra/near/requirements.txt
infra/near/.venv/Scripts/python.exe -m pip check
infra/near/.venv/Scripts/python.exe -m unittest discover -s infra/near -p "test_*.py" -v
```

Linux uses `.venv/bin/python` instead of `.venv/Scripts/python.exe`. CPU-only
verification needs internet access to Intel collateral/PCCS and NVIDIA NRAS/JWKS.
Tests are offline; their public historical fixture fixes validation time only in
test code and exercises actual Intel and NVIDIA signature verification.

## Subprocess protocol

Run `python infra/near/verify.py --policy <reviewed-policy.json>`. Stdin is one JSON
object, maximum 2 MB:

```json
{"attestation": {"...": "a single direct model report"}, "nonce": "64 hex characters", "tlsSpkiSha256": "64 hex characters"}
```

The caller must generate a fresh cryptographically random 32-byte nonce, GET the
report from the model's direct HTTPS origin, and supply the **actual peer SPKI
SHA-256** from that same CA-verified TLS connection. The caller must bind every
subsequent request to the returned SPKI and signer until `expiresAt`, reject
redirects, and never send the prompt if verification fails. The CLI cannot attest
to a caller's socket; supplying the report's claimed fingerprint as the peer
fingerprint defeats this boundary. Enclave's Node provider performs the socket
check and obtains a new session for every inference.

Each inference also includes `user: "enclave-<random UUID v4>"` in its exact JSON
request body. SGLang's standard `ChatCompletionRequest.user` field accepts this
value. It is a cryptographically random per-request nonce, never an account,
session, or personal identifier. Since NEAR signs the request-body hash, an old
signature cannot authorize a new call with the same prompt and identical output.
This establishes freshness of the signed request; it does not prove that the
provider recomputed tokens instead of using an authorized cache.

Success: exit 0, one JSON object containing `ok`, `signingAddress`,
`tlsSpkiSha256`, `attestationRef`, `verifiedAt`, `expiresAt`, `cpuStatus`,
`gpuCount`, `measurements`, `policyVersion`, `policySha256`,
`composeManagerActionsSha256`, `composeManagerImage`, `nvidiaEvidenceSha256`, and
`nvidiaEvidence`. Times are UTC ISO strings. Session lifetime is at most 300
seconds and bounded by policy and NVIDIA token expiry. Failure: exit 1, one
fixed-code `{"ok":false,"error":"..."}` object. No raw exceptions or report text
are logged. Missing services, unsupported formats, old TCBs, and policy changes
fail closed.

The signed NVIDIA JWT bundle is public evidence, but the application retains the
whole transcript encrypted because it also contains prompts and outputs. To
reconstruct the reference, use recursive key-sorted compact UTF-8 JSON with no
ASCII escaping:

```text
nvidiaEvidenceSha256 = SHA256(canonical(nvidiaEvidence))
policySha256 = SHA256(canonical(exactLoadedPolicy))
attestationRef = 0x || SHA256(canonical({
  "input": exactStdinDocument,
  "policy": exactLoadedPolicy,
  "nvidiaEvidenceSha256": nvidiaEvidenceSha256
}))
```

Preserve the exact input, loaded policy, and signed NVIDIA bundle alongside the
verdict. A second NRAS request creates different signed tokens and cannot
reconstruct the original reference. To recheck historical evidence, obtain the
NVIDIA verification key from an independently trusted NVIDIA source; an included
JWK is not a trust anchor. Live CLI modes use fresh collateral and a fresh NRAS
response. They never consume caller-supplied historical NVIDIA tokens.

### Cloud archive replay

Live Cloud verification uses `--cloud` and preserves the complete returned
`gatewayVerdict` and ordered `modelVerdicts` alongside its top-level verdict.
Every model verdict includes the exact signed `nvidiaEvidence` bundle and its
digest. Keep these fields, the original report, nonce, measured TLS SPKI, and
exact loaded policy in the encrypted transcript. Older archives without these
fields cannot pass hardware replay. Saving a verdict does not approve a policy.

Use the separate `--cloud-archive` mode to verify those saved hardware facts:

```powershell
python infra/near/verify.py --cloud-archive --policy <reviewed-policy.json> --policy-sha256 <0x-prefixed-SHA256-of-exact-policy-file>
```

Stdin is one document containing `nonce`, `tlsSpkiSha256`, `model`, the original
Cloud `attestation` report, and its complete `archivedVerdict`. The optional
`--policy-sha256` argument is available to every mode and rejects changed policy
bytes before verification; production acceptance supplies the operator-reviewed
digest. The policy must authorize each complete historical workload and remain
valid at replay. Its exact contents must match the original policy commitment.
Policy replacement or expiry cannot silently authorize an old archive.

Archive mode verifies Intel quotes with current collateral and reconstructs the
Gateway and model measurement, nonce, signer, SPKI, and workload bindings. It
fetches verification keys only from NVIDIA's fixed, CA-verified NRAS JWKS URL.
It performs no GPU attestation POST and never trusts an included JWK. Saved
NVIDIA aggregate and device signatures, nonce, device-set binding, and security
claims are verified at the saved model validation instant, bounded by the signed
JWT timestamps and a maximum history of 30 days. All child and aggregate session
times and expiries must be consistent. The saved clock value is not independently
authenticated by the hardware quotes: the caller must also compare it with the
signed provider evidence and trusted acceptance record.

Using the saved signed bundles allows the verifier to reconstruct the original
model and Cloud attestation references without issuing new NVIDIA tokens. It
rejects altered references, signers, policy commitments, or verdict fields.
Success returns the historical `verifiedAt` and `expiresAt`, plus
`archivedHardwareVerified: true` and the current `replayedAt`. Historical session
expiry is expected; this result never creates a live TLS session or authorizes a
new prompt. `--cloud` rejects an `archivedVerdict` input. New inference always
uses live verification and a fresh nonce before transmitting its prompt.

### Direct-model archive replay

The experimental direct endpoint path preserves the complete ordinary direct
verdict, including its exact `nvidiaEvidence` bundle, alongside the original
single model report. It uses the same complete measured model policy and
operator-reviewed policy digest. Gateway profiles are required for Cloud
verification; a direct-model policy does not need them.

Use `--direct-archive` with `--policy` and the pinned `--policy-sha256` to replay
that format. Stdin contains `nonce`, `tlsSpkiSha256`, the original direct
`attestation` report, and its `archivedVerdict`. The verifier reconstructs exactly
the original direct input, verifies both Intel quotes and measured runtime action
bindings, obtains keys from the fixed NVIDIA JWKS URL, and verifies the saved
NVIDIA bundle at its bounded historical instant. It performs no replacement GPU
attestation POST. Current and historical policy validity, the 30-day history
limit, exact original reference, signer, and session expiry remain required.

The direct verdict identifies one `signingAddress`; its report's `model_name`
identifies the workload. It has no Cloud `gatewayVerdict`, `modelVerdicts`, or
`allowedSigners` array. Successful replay adds `archivedHardwareVerified: true`
and `replayedAt` while preserving the historical session times. Live direct
verification rejects `archivedVerdict`, and direct archive mode rejects Cloud
report wrappers. Archive replay does not turn an expired session into permission
to send a new prompt. New direct inference still requires a fresh nonce, live
hardware verification, and the actual CA-verified socket SPKI before transmission.

## What is checked

* Both model and compose-manager Intel TDX quotes are cryptographically verified
  by `dcap-qvl` against Intel's root, collateral signatures, and revocation data.
  Overall, QE, and platform statuses must all be `UpToDate` without advisories.
  Debug TDX and unsupported quote report types are rejected.
* Model report data must equal `SHA256(signerAddressBytes || peerSpkiBytes) ||
  clientNonce`. This binds the response signing identity and TLS public key to
  the verified quote; neither key is pinned permanently in policy.
* Full MRCONFIGID must be `01 || SHA256(app_compose UTF-8) || 15 zero bytes`.
  Every boot/runtime measurement and attribute must match one complete reviewed
  profile; fields cannot be mixed between profiles.
* The compose-manager quote must have identical TDX measurements and PPID to the
  model quote. Its signed report data must equal `SHA256(canonical(actions)) ||
  clientNonce`. The complete action history and the last reported manager start
  image must match the reviewed profile. Runtime changes require a new review.
* Raw GPU evidence is submitted only to NVIDIA's fixed HTTPS NRAS endpoint.
  Aggregate and every per-GPU JWT receive real ES384 signature, issuer, nonce,
  freshness, expiry, and fixed-source JWKS checks. Device token hashes must match
  aggregate submodules. Missing/duplicate devices, failed measurement/certificate
  checks, warnings, debug mode, insecure boot, and unexpected GPU models/counts
  are rejected. No response-supplied JKU/JWK endpoint is followed.

## Policy review and maintenance

`policy.example.json` is deliberately expired and empty. A candidate command
fetches fresh public evidence and performs real hardware verification but creates
an **expired**, explicitly unapproved policy:

```powershell
infra/near/.venv/Scripts/python.exe infra/near/candidate.py glm-5-3-flash.completions.near.ai --output infra/near/.work/candidate.json
```

The candidate writer refuses to overwrite any existing file. Review the base
compose, every runtime action, official immutable source files and image digests,
then choose a policy version, `validFrom`, and `validUntil`. Place the approved
policy at the configured API path using an atomic replacement. The CLI loads it
on every invocation; there is no automatic TOFU, policy expansion, TCB exception,
or permanently trusted TLS certificate. Full measurement pinning deliberately
rejects unknown VM migrations and software changes until reviewed. Validity is
operational review expiry, not a replacement for Intel/NVIDIA revocation checks.

`probe.py <direct-host> --output <file>` saves public evidence without claiming it
is verified. Neither helper needs an API key or runs paid inference.

## Trust limits

Hardware validity does not by itself prove an arbitrary model name, model-weight
bytes, or the behavior of every privileged service. The current NEAR base compose
includes a privileged compose-manager, an image environment override, and a
launcher that can update containers. Its quote authenticates the **reported
action history** inside the same measured VM; the payload does not contain a
separate runtime measurement of the currently executing manager binary. The
`compose_manager_started` image digest is covered by the quote but remains a
manager assertion. Pinning it does not remove trust in NEAR's privileged control
plane, launcher, and measured guest OS. Similarly, GPU association is supplied by
the trusted in-VM attestation code; Intel's report data does not directly hash the
GPU evidence.

The development GLM profile therefore represents an explicit, time-bounded trust
decision about NEAR's published deployment. It is not a full source audit, a proof
of byte-for-byte model weights, an Enclave-owned TEE deployment, or proof that
privileged maintainers cannot alter the runtime. A stronger workload guarantee
requires a provider design that measures immutable runtime updates and binds
them to the quote, or an independently controlled immutable deployment.

## Official sources

* [NEAR model verification](https://docs.near.ai/cloud/verification/model) and
  [TLS verification](https://docs.near.ai/cloud/verification/tls).
* [NEAR reference verifier](https://github.com/nearai/nearai-cloud-verifier),
  reviewed commit `94554726fd548676842b7ea603a8173a60c31341`.
* [Phala dcap-qvl](https://github.com/Phala-Network/dcap-qvl) and
  [Python package](https://pypi.org/project/dcap-qvl/0.6.3/).
* [NVIDIA NRAS v3](https://docs.api.nvidia.com/attestation/reference/attestmultigpu_1)
  and [fixed JWKS](https://nras.attestation.nvidia.com/.well-known/jwks.json).
* [NEAR runtime compose files](https://github.com/nearai/cvm-compose-files).
* [SGLang ChatCompletionRequest schema](https://github.com/sgl-project/sglang/blob/main/python/sglang/srt/entrypoints/openai/protocol.py)
  (`user: Optional[str]`, checked 2026-09-19).

The upstream examples print some failed checks and permit `OutOfDate`; this
enforcement layer deliberately does neither. It verifies NVIDIA JWT signatures
instead of merely decoding their payloads.
