# NEAR GPU development

NEAR is the selected GPU TEE inference provider. This profile verifies a managed NEAR model before sending it a prompt. The Enclave gateway, session key handling, agent memory and receipt signer still execute in a local software CVM. `NODE_ENV=production` remains rejected. Hardware acceptance of the remote model is not acceptance of the whole Enclave TEE design. Completing the remaining gateway and agent isolation requirements does not mandate a switch to Phala.

See [the CVM deployment requirements and current account status](near-cvm-deployment.md) for the access needed to host our own gateway at NEAR. The inference key alone does not provide that deployment access.

## Setup

Run from the repository root. Use Python 3.10+ supported by `dcap-qvl`:

```powershell
py -3.13 -m venv infra/near/.venv
infra/near/.venv/Scripts/python.exe -m pip install -r infra/near/requirements.txt
infra/near/.venv/Scripts/python.exe -m pip check
Copy-Item infra/near/.env.example .env.near
```

Copy the example only for a **new** profile; do not overwrite an existing key. Set `INFERENCE_API_KEY` in the ignored `.env.near` to a NEAR Cloud key with a small spending limit. Keep regular local database/chain settings in `.env`. Neither file belongs in Git. Linux uses `infra/near/.venv/bin/python`.

The GLM development policy is time bounded and expires on 26 September 2026. It accepts only reviewed complete measurement profiles, manager action histories, GPU counts and models. Changes or new VMs require a review and an atomic policy replacement; do not regenerate an automatically trusted policy from the latest response. A versioned candidate is deliberately unapproved/expired. See [the verifier protocol and review procedure](../infra/near/README.md).

```powershell
# Offline vendor crypto/negative tests; no API key or inference spend:
infra/near/.venv/Scripts/python.exe -m unittest discover -s infra/near -p "test_*.py"

# Explicit paid smoke: one synthetic prompt, at most 32 output tokens:
npm run near:check

# Full explicit paid acceptance in disposable Postgres/Redis/Anvil:
npm run test:integration -- --near-live

# The same paid acceptance without rerunning the offline suites:
npm run near:check:gateway

# Normal gateway, using the existing local database/chain:
npm run dev:near
```

The regular integration/CI suites never invoke paid inference. `--near-live` additionally checks encrypted input/output, the remote signature, receipt binding, restart/idempotent replay, view-key export, local MockUSDC settlement and an actual receipt anchor transaction on disposable Anvil. It creates no mainnet transactions and does not prove Arc privacy. The smoke scripts print/save metadata only, under ignored `work/`, and never automatically retry a generation POST.

For the normal gateway, migrate the database and register/approve the exact serving model/code pair before inference. The existing `scripts/register-serving-model.ts` supports an explicit local `--apply --bootstrap` flow; it does not deploy or reset contracts. Keep the operator wallet and NEAR credential separate.

## Verification boundary

1. Fetch a direct model report with a fresh random nonce over CA-validated HTTPS and extract the peer SPKI from that very connection. No API credential or prompt is needed for this public request.
2. A subprocess with a restricted environment verifies both Intel model/manager quotes and their binding, strict current TCB status, NVIDIA signed aggregate/device claims, full measurement policy and policy expiry. It never receives the inference API key.
3. Continue on the same TLS connection when possible. A reconnect must pass hostname/CA verification and the freshly attested SPKI before application bytes can be sent; TLS resumption is disabled. The session expires within five minutes and is closed after the inference.
4. Send one bounded non-streaming prompt. A per-call random `user` identifier is included in the exact signed request bytes; it contains no user/session identity. Verify the exact response bytes and a canonical ECDSA signature from the attested signer. An old completion signature cannot authorize a different request hash.
5. Check model, prompt and output association again before signing the local receipt. Encrypt the transcript with the session key and persist it with the sidecar. Recheck model approval after a potentially slow inference so an in-flight revoked model cannot publish a result.

`verifyProviderProof` checks the local receipt/signature association. `verifyNearTranscript` checks wire hashes, content consistency and the NEAR signature. Neither standalone function substitutes for Intel/NVIDIA verification or for the caller's actual TLS-peer check. Retain the encrypted hardware evidence, signed NVIDIA bundle and exact reviewed policy to reconstruct the evidence reference; the verifier README specifies the format.

## Current limitations

The measured base VM includes a privileged deployment manager and launcher. Its signed action history does not independently measure the currently executing manager binary or authenticate all runtime overrides. The development policy explicitly trusts NEAR's measured guest/control plane and pins its reported deployment. It is not a proof of immutable runtime updates or byte-for-byte weights. GPU association also depends on that measured in-VM attestation code.

The standard `modelHash` remains a hash of the model identifier, and the local `codeHash` describes the software serving policy. The NEAR hardware reference is a separate field, not a silent upgrade of those claims. Moving the gateway/agent wallet into an independently controlled measured TEE and implementing a stronger on-chain hardware-policy admission path remain necessary for the full specification.

Unknown hardware, unavailable collateral/NRAS, an expired policy or a failed signature returns an error. There is no fallback to unverified NEAR, Modal or synthetic output. Do not relax these checks to improve availability.

Official references: [NEAR TLS verification](https://docs.near.ai/cloud/verification/tls), [model verification](https://docs.near.ai/cloud/verification/model), and [chat signatures](https://docs.near.ai/cloud/verification/chat).
