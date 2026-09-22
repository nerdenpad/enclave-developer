# Durable software agent runtime

The API includes an executable, bounded reasoning loop backed by PostgreSQL. It uses the existing Enclave gateway for quote verification, sessions, encrypted inference and payment settlement. The model returns only `{"action":"continue"|"complete","output":"..."}`; it cannot invoke arbitrary tools, shell commands, browser actions or wallet operations. A tick executes at most one inference step.

This is a **software host runtime**, not an enclave-owned hardware agent or an attested wallet. NEAR protects the selected remote inference environment. The local gateway, process memory and stored CVM wrapping key retain the deployment trust described in the main README. A NEAR inference API key does not itself provision a confidential VM for this process.

## Enablement and limits

`AGENT_RUNTIME_ENABLED` defaults to `false`. The application wires a periodic runner only when explicitly enabled. Every run requires an agent owned by the calling API key, an idempotency key, a positive finite USDC-unit budget, a step limit and a future deadline. Host configuration bounds those values further. One USDC is 1,000,000 units.

Use an inference model that can follow the strict JSON decision protocol. The built-in echo adapter is for lower-level inference tests and does not produce these decisions. Invalid model output ends the run with `AGENT_DECISION_INVALID`; it is not automatically retried.

The runtime constructor receives its host secret from the existing CVM key store. It does not generate a wallet, read additional secret files, mint tokens or fall back from authorized payments. Automatic mock settlement is permitted only when explicitly enabled on local chain ID 31337. Authorized mode always pauses for an externally signed payment authorization.

The gateway/provider request timeout must remain finite. Configure the runtime call timeout above the provider's own timeout plus settlement overhead, and the lease sufficiently above that call timeout. Heartbeats renew live leases. A runtime timeout fences off the result and requires reconciliation; it cannot undo an already accepted blockchain transaction or remote inference request. The current gateway method has no caller `AbortSignal`, so the provider's independent timeout remains the upper bound for its underlying HTTP operation. The runner never starts a replacement paid request for an uncertain call.

## HTTP interface

All routes require the owner's `x-api-key`; results never contain the key, session wrapping keys, plaintext goals, reasoning history or plaintext final output.

| Request | Behavior |
| --- | --- |
| `POST /v1/agent-runs` | Create or replay an owner-scoped idempotent run. |
| `GET /v1/agent-runs?after=<run UUID>&limit=50` | List owner metadata, using a UUID keyset cursor and a maximum page size of 100. |
| `GET /v1/agent-runs/:id` | Read status, spending, payment challenge and authenticated journal metadata. |
| `GET /v1/agent-runs/:id?sessionId=<owner session UUID>` | Additionally export a completed result encrypted to a currently valid owner session. Gateway key release checks current TCB policy. |
| `POST /v1/agent-runs/:id/cancel` | Request cancellation. A call already dispatched may still complete; its receipt/payment is retained. Cancelled results are not exported. |
| `POST /v1/agent-runs/:id/resume` | Supply an external payment authorization or explicitly reconcile an uncertain outcome. |

Create request:

```json
{
  "agentId": "<existing owned agent UUID>",
  "goal": "Develop a short plan and finish when it is complete.",
  "maxSteps": 3,
  "maxBudgetUnits": "300000",
  "deadlineAt": "<future UTC timestamp within the configured duration>",
  "idempotencyKey": "client-run-unique-id"
}
```

The goal is submitted over the authenticated HTTPS connection and encrypted before database persistence. A model receives the goal, the last four step outputs, the step number and protocol instructions. It never receives API credentials, payment authorizations, wrapping keys or raw database state. Existing agent policy and encrypted memory are still enforced by the gateway.

When status is `awaiting_payment`, the response contains the existing v1 x402 challenge and its `paymentId`. An external wallet uses the gateway's existing payment-authorization workflow. Resume with:

```json
{
  "authorization": {
    "from": "<payer EVM address>",
    "validAfter": "0",
    "validBefore": "<authorization expiry as uint256 seconds>",
    "signature": "<65-byte signature as 0x hex>"
  }
}
```

The runtime does not create or sign this authorization. The gateway validates ownership, authorization, mandates, model approval and settlement. A challenge must match an owner-owned open database payment intent and its amount before the runtime accepts it. Total settled spending is charged against the run budget even when later inference fails. Funds already settled are not automatically refunded on cancellation, expiry or invalid model output.

## Durable state and recovery

`agent_runs` stores encrypted credentials, goal, history and pending request details, plus bounded status/budget/lease metadata. `agent_actions` stores an ordered encrypted action journal. HKDF-SHA256 derives separate AES-GCM and journal keys from the injected 32-byte host secret, with explicit owner, run and purpose separation. AES-GCM authenticates that context as additional data, so swapping ciphertext between owners, runs or purposes fails. Budgets, deadline, agent identity and spending/history consistency are also checked against authenticated state.

Each journal record includes the previous record hash, sequence, action kind, timestamp and encrypted payload. A keyed HMAC authenticates the chain; read operations verify it against the persisted head. No plaintext prompt, credential, provider exception or model output is stored in journal metadata. This detects modification and incomplete journals relative to the saved head. It does not provide an external anti-rollback anchor against restoration of an entire older database snapshot; production audit anchoring remains separate.

PostgreSQL claims use `FOR UPDATE SKIP LOCKED`, row versions and fresh lease tokens. Heartbeat updates require the same unexpired token. State and journal writes commit together and reject stale worker tokens using a clock sampled after acquiring the row lock. Expired leases are rechecked under a row lock before quarantine, so a heartbeat renewed after the initial scan is not overwritten. Paid dispatch admission also checks cancellation and deadline while holding the row lock. Cancellation committed before admission prevents the call; cancellation after a committed dispatch cannot undo it.

Status reads recheck the row version around journal retrieval and retry up to three times when another worker advances it. A continuously changing run returns `409 AGENT_STATE_CHANGED`, rather than reporting a false journal-integrity failure. Genuine tampering in a stable snapshot still fails closed.

The runner commits `settlement_dispatched` or `inference_dispatched` **before** invoking the side effect. Process interruption, transport failure or timeout leaves `outcome_unknown`; there is no automatic paid retry. The next explicit resume follows these rules:

1. For an uncertain inference, read the owner's existing gateway idempotency response. If present, authenticate/decrypt it with the saved session key, check its output hash and process the strict decision. No inference call is made. Missing proof returns `AGENT_RECONCILIATION_REQUIRED`.
2. For uncertain settlement, require an owner-owned matching payment amount, settled status and transaction hash from the existing gateway payment journal. Continue from the paid stage without calling settlement again. The gateway's existing canonical-chain checks still guard payment consumption. Pending/unknown/consumed or otherwise inconsistent proof remains quarantined.
3. Interrupted preparation with no paid dispatch marker may be requeued explicitly. A session that expired while paused fails closed instead of changing the session-bound request behind an existing payment intent.

Repeated resume/cancel requests do not authorize new spending. Cancellation during an unknown operation preserves quarantine until the outcome is reconciled. New steps stop at the configured deadline, budget or step cap. Invalid model decisions retain their receipt/payment metadata and terminate the run.

Preserve the wrapping key and database together across restarts. A missing or changed key makes encrypted state unavailable; the runtime does not silently rotate it or restart a paid operation. Recovery of pending payments, backup/restore, hardware key custody and immutable workload assurance remain distinct deployment responsibilities.

## Verification

Unit tests exercise the actual runtime and Hono routes with a deterministic gateway fixture: concurrent claims, restart recovery, cancellation races, nonce/idempotency stability, payment pauses, financial caps, corrupted state/journals, timeout quarantine and secret-redaction canaries. They do not call a paid model.

```sh
npm test --workspace @enclave/api -- src/agent-runtime.test.ts
npx tsc --noEmit -p apps/api/tsconfig.json
```

The separately gated `agent-runtime-store.integration.test.ts` uses the repository's disposable integration PostgreSQL environment to exercise the production store across independent connections. `agent-runtime-gateway.integration.test.ts` runs the real gateway, cryptography and Anvil MockUSDC settlement with a local JSON-producing model fixture. It covers multiple steps across restart, encrypted result export and a failed runtime checkpoint after the gateway committed a receipt. No paid model is called. Never point the integration harness at a user database.
