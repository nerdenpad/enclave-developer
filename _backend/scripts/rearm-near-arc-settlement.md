Use this recovery for an acceptance payment whose settlement returned `503 INFERENCE_ATTESTATION_FAILED` before admission committed, only after establishing the original attempt was unspent. The helper does not start another acceptance run, create a signature or payment ID, call a provider, or change policy.

The protected original journal remains authoritative. Preserve its exact bytes and SHA256. Review the existing before-payment and blocked snapshots: matching wallet/plan scope, original payment open, no stored authorization or settlement/receipt/idempotency result, unchanged owner usage/receipt/idempotency counts, unchanged payer balance/spend, and no settlement events. The supplemental collector reads only the missing signed payment-transaction count, USDC authorization state and bounded `AuthorizationUsed` events, and the recorded block's canonical hash. It accepts an expiry window only when the baseline precedes the earliest possible authorization issuance (`validBefore - 600 seconds`) and the confirmed block follows expiry.

Run the checked-in scripts from `_backend`, with the existing private runtime environment loaded by Node. `scripts/acceptance-economics-snapshot.mjs` records the baseline and target counters; `scripts/collect-acceptance-no-spend.mjs` supplements those exact saved snapshots. The operator must first review the snapshots and recorded admission failure. Redirect JSON output into protected files. Neither helper prints a key, bearer, prompt, ciphertext, authorization signature, raw transaction, or private owner hash. The collector neither writes data nor signs. Its database query counts `chain_transactions` with `operation_key LIKE 'payment:<original UUID>:%'` across all scopes; any signed row refuses closure.

Example command structure, replacing capitalized placeholders with the existing private file paths or public identifiers:

```text
node --env-file=PRIVATE_ENV scripts/acceptance-economics-snapshot.mjs --plan PLAN_PATH --wallet PAYER_ADDRESS --label before-payment
node --env-file=PRIVATE_ENV scripts/acceptance-economics-snapshot.mjs --plan PLAN_PATH --wallet PAYER_ADDRESS --from-block BASELINE_BLOCK --payment-id ORIGINAL_PAYMENT_UUID --receipt-hash RECEIPT_HASH --idempotency-key ORIGINAL_IDEMPOTENCY_UUID --label after-payment
node --env-file=PRIVATE_ENV scripts/collect-acceptance-no-spend.mjs --plan PLAN_PATH --baseline BASELINE_PATH --snapshot BLOCKED_SNAPSHOT_PATH --journal-sha256 ORIGINAL_JOURNAL_HASH --payment-id ORIGINAL_PAYMENT_UUID --nonce ORIGINAL_PAYMENT_NONCE --authorization-expires-at ORIGINAL_EXPIRY_Z_TIMESTAMP --reviewed-by "Release operator"
```

Omit `--receipt-hash` when the failed attempt has no receipt. The payment nonce is `keccak256` of the UTF-8 payment UUID, and must match the signed original authorization. The collector checks this binding rather than trusting the supplied nonce. It requires both snapshot scopes to match the plan and supplements only the missing reads; it does not repeat the completed payment, usage, balance, spend, or settlement-event reads.

Use the exact original plan and journal locally:

```powershell
npx tsx scripts/rearm-near-arc-settlement.ts --plan PLAN --state ORIGINAL_JOURNAL --proof NO_SPEND_PROOF --archive-aborted
```

The default is dry-run. Add `--execute` only for the explicit local archive step after reviewing the result. The proof must be at most 60 seconds old and match the original journal SHA256, wallet, plan, payment, and nonce. Archive requires the original `validBefore` to be expired both locally and at the proven canonical block. It verifies the original EIP-3009 signature and encrypted request, acquires the same journal lock, saves exact original journal bytes plus proof privately as `settlement-recovery.json`, then changes only phase to `aborted-unspent`. It refuses overwriting an existing recovery record. Execution/recovery modes reject this terminal journal before API or chain calls; it is never reseeded or deleted.

Without `--archive-aborted`, the helper can rearm only a still-valid original authorization and session. That path changes only phase to `challenge`; a separately invoked runner sends the original settlement authorization verbatim. An expired signature is never renewed or replaced. A fresh acceptance attempt after independently proving unspent expiry uses a separate journal and a new plan when its scope changes; retain the aborted original.

Reproduce the helper checks from a clean checkout:

```text
node --test scripts/acceptance-economics-snapshot.test.mjs scripts/collect-acceptance-no-spend.test.mjs
npx vitest run scripts/rearm-near-arc-settlement.test.ts scripts/accept-near-arc.test.ts
```

All tests use synthetic identities, signatures and counter fixtures with injected RPC/DB data. They do not require private files, establish live hardware acceptance, or perform a paid request.
