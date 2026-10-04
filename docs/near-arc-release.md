# NEAR + Arc release profile

The `managed-near` profile uses verified NEAR inference and authorized Arc USDC settlement. The application gateway issues software session descriptors; provider CPU/GPU evidence is a separate verification boundary checked before a prompt is sent. Receipt model and code hashes commit to the selected model identifier and application serving policy. They are not independent hashes of model weights or a reproducible image build.

The selected route is **experimental direct NEAR**: `NEAR_ENDPOINT_PROFILE=direct-experimental` with the exact model endpoint `https://<model-label>.completions.near.ai/v1`. This route can enter the accepted production profile only after strict node verification and the release acceptance below. Selecting an endpoint does not establish readiness. The Cloud Gateway remains a separate supported route using `NEAR_ENDPOINT_PROFILE=cloud` and `https://cloud-api.near.ai/v1`; changing routes requires matching policy review and a new accepted archive.

Reviewed provider policy v6 and its new accepted release were installed on
**4 October 2026** after a real 0.10 USDC operator EOA request returned complete
`READY` content and a verified receipt with confirmed Arc settlement/anchor.
Archived and fresh production startup verification passed; public backend and
provider readiness were true at 10:05 UTC. The policy hash is
`75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa`;
its expiry remains **8 October 2026 at 14:29:11 UTC**. Physical OKX and remaining
E1 operational acceptance stay open. See [release progress](release-progress.md).

`NEAR_DIRECT_ADMISSION_ATTEMPTS` defaults to `1` and accepts integers from 1 to 3.
The deployed value is `3`. Values above one require managed verified NEAR,
the explicit direct profile and an exact provider-policy SHA-256 pin. Only a
trusted verifier's `WORKLOAD_NOT_APPROVED` rejection can select another candidate
before dispatch. Each attempt creates a new nonce and verified connection; rejected
connections are closed and policy bytes must stay unchanged. One original abort
deadline bounds all attempts. Cloud mode remains one attempt. TLS, CPU/GPU,
nonce, signature and protocol failures are terminal; inference POSTs are never
repeated by this mechanism. All candidates may still be rejected.

## Prepare acceptance

GPU verification is also explicit. The default `NVIDIA_VERIFIER_MODE=nras` checks
NVIDIA-signed results. The Linux `local` profile requires the pinned NVAT 1.2.2
binary and library, matching `nvidiaVerifier` fields in the reviewed provider
policy, and access to official signed RIM/OCSP collateral. It independently
verifies the original raw GPU reports; it never treats a local EAT as
NVIDIA-issued proof. Archive replay re-appraises those reports against current
collateral and preserves the original signed transcript commitments. It does
not claim offline historical OCSP verification. See
[local verifier configuration](../_backend/infra/near/README.md#local-nvidia-verification).
Changing verifier profiles requires a new reviewed policy and accepted archive.

1. Review the provider node's complete measurements, immutable image provenance and runtime actions for the exact model and route. Store a versioned policy with reviewed model `profiles`, a bounded validity interval and production review provenance. The Cloud Gateway route additionally requires reviewed `gatewayProfiles`. Compute the SHA-256 of the exact policy file bytes. Never populate approved profiles automatically from an unreviewed response.
2. Choose the final model identifier, application serving identity and policy version. Register and approve their computed model, code and policy commitments in Arc ModelRegistry. Activate that exact on-chain policy through the existing administrative policy lifecycle while the service remains in pilot mode.
3. Complete one hosted inference on the selected endpoint with strict provider checks. The direct route requires fresh node CPU/GPU verification, a fresh nonce, CA-validated TLS with the observed peer key bound to the quote, and a response signature from the verified node signer over the exact request and response bodies. Preserve the signed receipt, signed provider proof and private transcript, including the original node report, complete verdict, signed GPU evidence, loaded policy and actual TLS fingerprint. For the cloud route, preserve the Gateway report and all model verdicts instead. Confirm the receipt's canonical Arc anchor.
4. Complete the agreed small USDC browser payment and verify that the persisted payment points to the same receipt. Confirm wallet ownership, duplicate request handling and recovery after restart. Approve the commercial price separately.
5. Create a private release manifest using `productionReleaseManifestSchema` in the core package. It binds the final HTTPS origin, exact inference endpoint, chain, contracts, signer, serving commitments, exact provider policy file, accepted inference archive, receipt anchor and linked payment transaction. Acceptance expires within 30 days and cannot outlive the reviewed provider policy.

Run the offline check from `_backend`:

```sh
npm run check:production-release -- --manifest /absolute/private/path/accepted-release.json
```

The offline check validates file hashes, receipt and provider signatures, transcript and input/output bindings, provenance, commitments and dates. Its output explicitly reports that hardware, blockchain and payment acceptance have not been independently established by that command. Private input and output bytes are never printed.

The hosted acceptance runner performs one explicitly authorized wallet-authenticated API request, signs a bounded USDC authorization, and preserves the private evidence in a durable journal. Its default mode is read-only:

```sh
npm run acceptance:near-arc -- --plan /private/acceptance-plan.json --state /private/acceptance-run/state.json --env /private/operator.env
```

Add `--execute` for the approved test, `--recover` for read-only recovery, or `--prepare-manifest` to recheck a saved result. A generated manifest remains a review candidate until its recorded facts are accepted. See the [acceptance operator guide](../_backend/scripts/accept-near-arc.md) for the plan, protected storage, payment cap and recovery rules. Browser wallet confirmation and the commercial price are checked separately before public checkout is enabled.

## Start the accepted profile

Use `.env.near-arc.example` as the configuration template. Keep the actual environment, policy, manifest, transcript and persistent signer files outside Git.

For the selected GLM-5.3-Flash model, configure `NEAR_ENABLE_THINKING=true`,
`NEAR_MAX_TOKENS=512` and `INFERENCE_TIMEOUT_MS=180000`. The pinned model chat
template always opens a thinking block; setting `enable_thinking=false` does
not disable model thinking and can prevent the serving parser from separating
reasoning from the final answer. Acceptance must inspect the exact signed
response for a usable final `message.content` and its termination reason.
These request controls are committed by the provider request hash, while the
application serving hashes and hardware allowlist do not separately commit
the token budget. Retain the prior archive and record a new accepted request
when changing these controls. The generic thinking setting defaults to false;
the selected model requires this explicit override. See the
[pinned model template](https://huggingface.co/zai-org/GLM-5.3-Flash/blob/3f1971b7b5f7a528c9c4ef6212c8785298a8c24a/chat_template.jinja)
and [model publisher guidance](https://docs.z.ai/guides/vlm/glm-5.3-flash).

Production readiness requires all of the following:

- Explicit NEAR endpoint profile, its exact canonical HTTPS endpoint and pinned reviewed provider policy bytes. Direct mode uses only the approved `<model-label>.completions.near.ai/v1` endpoint; it does not silently fall back to the Cloud Gateway.
- Reviewed acceptance manifest matching runtime configuration and the persistent receipt signer.
- A completed stored payment linked to the accepted receipt.
- Canonical, confirmed Arc receipt and payment transactions with the exact expected events, configured signer, token, registry, vault and operational relay.
- The exact active on-chain application policy.
- Independent replay of the archived provider/node evidence and exact transcript bindings, followed by a fresh node attestation preflight on the accepted endpoint. Cloud mode also verifies the Gateway and every returned model candidate. Startup sends no inference prompt.

Missing keys cannot be regenerated during production startup. Expired acceptance rejects further admissions. Every inference still performs fresh provider verification; an accepted manifest never bypasses live attestation.

The backend readiness correction was deployed on 3 October 2026. After
validating the release, archived evidence, keys and chain wiring, it keeps status,
wallet sign-in and stored history available on a known fresh provider rejection,
while reporting not ready and rejecting new payment/inference admission. See the
[correction record](release-progress.md#backend-readiness-correction--3-october-2026).
That dated rejection was superseded by the separately reviewed and paid-accepted
v6 release on 4 October; the readiness correction still applies to future known
provider rejections.

Build the frontend with the agreed public payment configuration only after acceptance. The `/status` page reports the inference route, active release profile, provider policy fingerprint and expiry, payment network and known verification boundaries. Direct mode is labeled **Experimental direct NEAR**, including after acceptance. Production readiness remains a gateway report of validated release checks; this page does not independently prove hardware, transcript or payment acceptance. Gateway key custody remains software-managed.

Policy renewal, interrupted-payment recovery and release rollback are covered in
[NEAR and Arc operations](near-arc-operations.md).
