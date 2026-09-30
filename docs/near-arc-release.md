# NEAR + Arc release profile

The `managed-near` profile uses verified NEAR inference and authorized Arc USDC settlement. The application gateway issues software session descriptors; provider CPU/GPU evidence is a separate verification boundary checked before a prompt is sent. Receipt model and code hashes commit to the selected model identifier and application serving policy. They are not independent hashes of model weights or a reproducible image build.

The selected route is **experimental direct NEAR**: `NEAR_ENDPOINT_PROFILE=direct-experimental` with the exact model endpoint `https://<model-label>.completions.near.ai/v1`. This route can enter the accepted production profile only after strict node verification and the release acceptance below. Selecting an endpoint does not establish readiness. The Cloud Gateway remains a separate supported route using `NEAR_ENDPOINT_PROFILE=cloud` and `https://cloud-api.near.ai/v1`; changing routes requires matching policy review and a new accepted archive.

## Prepare acceptance

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

## Start the accepted profile

Use `.env.near-arc.example` as the configuration template. Keep the actual environment, policy, manifest, transcript and persistent signer files outside Git. Production startup requires all of the following:

- Explicit NEAR endpoint profile, its exact canonical HTTPS endpoint and pinned reviewed provider policy bytes. Direct mode uses only the approved `<model-label>.completions.near.ai/v1` endpoint; it does not silently fall back to the Cloud Gateway.
- Reviewed acceptance manifest matching runtime configuration and the persistent receipt signer.
- A completed stored payment linked to the accepted receipt.
- Canonical, confirmed Arc receipt and payment transactions with the exact expected events, configured signer, token, registry, vault and operational relay.
- The exact active on-chain application policy.
- Independent replay of the archived provider/node evidence and exact transcript bindings, followed by a fresh node attestation preflight on the accepted endpoint. Cloud mode also verifies the Gateway and every returned model candidate. Startup sends no inference prompt.

Missing keys cannot be regenerated during production startup. Expired acceptance rejects further admissions. Every inference still performs fresh provider verification; an accepted manifest never bypasses live attestation.

Build the frontend with the agreed public payment configuration only after acceptance. The `/status` page reports the inference route, active release profile, provider policy fingerprint and expiry, payment network and known verification boundaries. Direct mode is labeled **Experimental direct NEAR**, including after acceptance. Production readiness remains a gateway report of validated release checks; this page does not independently prove hardware, transcript or payment acceptance. Gateway key custody remains software-managed.
