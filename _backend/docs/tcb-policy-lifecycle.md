# Software TCB policy lifecycle

This control plane manages the gateway's **development software policy**. It does not deploy a new container, measure a binary, release hardware-protected keys or edit NEAR's remote attestation allowlist. All mutations require an administrator API key.

## Propose, register, approve, activate

1. Read `GET /v1/tcb/policies`. Retain the active version for the activation precondition.
2. Call `POST /v1/tcb/rotate` with `servingImageId`, an optional explicit integer `version`, and a stable `Idempotency-Key`. The response contains a pending policy, its `measurement` and `policyHash`. Serving remains on the previous policy.
3. Call `POST /v1/marketplace/list` with the serving `modelHash`, the proposed measurement as `codeHash`, a display `version`, `bps`, and both `policyHash` and `policyVersion`. Use a stable listing `Idempotency-Key`. The gateway checks the stored proposal and uses the policy-aware registry path.
4. Use the ordinary listing approval flow after the one-hour contract timelock. Check the deadline through `GET /v1/marketplace/:id/approval`. Explicitly enabled local fixtures may use `/bootstrap-approve` on chain 31337.
5. Call `POST /v1/tcb/:version/activate` with `{ "expectedActiveVersion": 1 }`, replacing `1` with the active version read in step 1, and a stable activation `Idempotency-Key`. Refresh before retrying a compare-and-swap conflict.

Activation requires the exact approved model, code, policy hash and version. It records the chain ID, genesis hash and registry address used for approval. Gateway admission checks that scope and current approval again. An older registry without `TCB_BINDING_VERSION() == 1` is rejected by the policy-aware path.

The hash commits to the full canonical software policy: version, serving image identifier and both required CPU/GPU flags. Versions are immutable. Reusing an idempotency key with different parameters fails. The database keeps one active policy; activation retires its predecessor. A database is a single serving-policy domain, so independent deployments should not share this state.

## Sessions and concurrent requests

Each gateway reloads active policy at admission boundaries. New policy sessions use a measurement-bound wrapping key. Quotes, session creation, session-key export, agent-memory writes and inference publication check the active generation. A request started under the old policy cannot publish a receipt or commit payment consumption after activation. The remote inference already dispatched may still finish and may incur provider cost; rotation does not cancel that external operation.

Restart restores the active policy and the same software-held keys. Existing bootstrap sessions retain their legacy derivation until a policy is activated. The initial compatibility state is labelled `legacy`, not on-chain approved. Inconsistent state or a history with no active policy fails closed instead of silently restoring an old version.

Sessions must retain their signed quote for admission to be revalidated. Older session rows without stored quote JSON are rejected with HTTP 401 before a payment is opened; obtain a fresh quote and create a new session. Legacy key derivation alone is not proof that the session was admitted under the current policy.

## Local fixtures and migration

`ALLOW_LOCAL_BOOTSTRAP=true` with configured chain 31337 permits activation without on-chain policy approval. Responses label this `local-fixture`; its scope is an explicit test label and does not verify the RPC genesis. This bypass defaults off. It cannot satisfy hardware or production acceptance.

Existing listings keep their ABI and legacy model/code approval behavior. They have no policy binding and cannot be upgraded in place because model/code pairs are unique. Register a new pair through `listWithPolicy` for the new version. Receipt v2 remains compatible: the Solidity verifier does not independently validate CPU/GPU vendor evidence.

The [NEAR CVM deployment requirements](near-cvm-deployment.md) describe the separate hardware work still needed.
