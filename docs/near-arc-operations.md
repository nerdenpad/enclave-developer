# NEAR and Arc operations

The API and worker run as `enclave-api` and `enclave-worker`. The website runs as
`enclave-web`. Source delivery to GitHub does not restart these services.

Keep the runtime environment, persistent signing files, provider policy and accepted
inference archive outside Git. A rollback must preserve the database, queues and
signing files. Recreating a key file changes the signer and invalidates existing
deployment commitments.

## Release and checkout

`/api/health` reports the backend release checks. `/status` displays the selected
route and release stage. Public browser checkout has its own build setting and
requires an approved price and a completed browser-wallet acceptance journey.
Backend acceptance alone does not enable checkout.

The selected NEAR route is experimental direct inference. Every request requires
fresh verification; there is no unverified inference fallback.

## Provider policy renewal

Both the provider policy and the accepted release have expiry dates. Before expiry:

1. Review the complete observed node profiles, immutable image provenance and
   runtime action history. Changed profiles require review; do not automatically
   trust new measurements or extend a date on an old policy.
2. Issue a versioned policy and record the SHA-256 of its exact file bytes.
3. Prepare a new release plan. Obtain authorization for its bounded paid acceptance
   request, retain its journal and verify its receipt, payment and Arc anchor.
4. Independently review the generated candidate and install the accepted manifest,
   archive and matching policy together. Restart the API and worker and check the
   release stage through HTTPS.

Expiry or rejected attestation blocks new admissions. It must not be resolved by
disabling evidence checks, accepting an outdated CPU status or changing the route
without a new review. Archived hardware evidence is replayed independently during
startup; a saved success verdict is not sufficient.

## Interrupted payments

Use the original acceptance journal and its exact plan. Start with the runner's
GET-only `--recover` mode. Preserve the payment ID, authorization nonce, encrypted
request and idempotency key. Do not create a second payment to resolve uncertainty.

`--execute --recover-completed` is available only when the server proves that the
original payment was consumed and the matching signed receipt persisted. It
retrieves that completed result. A missing receipt after an ambiguous provider
request is not permission to generate again.

Remote inference commits a durable `inference_executions` claim before dispatch.
If the process stops, the provider response is lost, or result publication fails,
the claim survives independently of the result transaction. The API returns
`409 INFERENCE_EXECUTION_UNCERTAIN` with the original payment ID. The dashboard
blocks another attempt and links to payment history. Do not delete a claim, reset
its status or attach another payment to the same intent. Review the retained
payment and provider evidence to resolve the customer case; no automatic refund
is implied. A committed result can still be retrieved from its exact cached response.

Deploy this migration before admitting paid requests. Drain all older API processes,
apply `db:migrate`, install the source and restart. Do not mix an older API that
does not honor dispatch claims with the new version.

For restart acceptance, retain the API process start time, original response digest,
payment and receipt counts, and owner usage before and after restart. Compare the
original result and canonical settlement event after replay. A matching receipt
hash alone does not prove that a process restarted.

An admission failure before settlement can be closed only with reviewed proof of
an open, unsubmitted payment, unchanged usage, no signed payment transaction,
no receipt/result, and an unused token authorization on the canonical chain.
An expired authorization must also be expired at that confirmed block. Use the
[explicit recovery helper](../_backend/scripts/rearm-near-arc-settlement.md) to
preserve the original journal and proof as `aborted-unspent`. This terminal record
never starts a replacement request. A separately authorized acceptance run keeps
its own plan and journal.

## Model and signer changes

ModelRegistry listings bind model, application code and policy commitments.
Approval has a one-hour contract timelock. Activate the approved policy through the
administrative lifecycle before changing the configured serving identity.

Revocation is permanent on Arc. Do not revoke the serving listing as a reversible
test. A replacement needs a new listing and release acceptance. Changing the receipt
signer also requires updated contract configuration, release evidence and browser
trust settings; old receipts may no longer pass the verifier's current policy.

The production API checks the current verifier signer and payment routing at one
canonical Arc block on each admission and again before publishing a new result.
A mismatch or unavailable RPC blocks admission; a successful check does not
replace the release review required for a planned signer change.

## Operating funds

The relay pays settlement and anchoring network fees. The treasury receives its
configured share of payments; it does not automatically refill the relay. Keep
replenishment manual until its limits and funding mechanism are agreed.

The customer price must cover model inference, network fees and the configured
revenue allocation. The approved commercial price is **0.10 USDC per request**.
See [payment launch](payment-launch.md) for wallet roles and fee boundaries.
