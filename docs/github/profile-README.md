<div align="center">

  <h1>Enclave</h1>

  <p><strong>Inference with signed receipts, attestation checks and on-chain verification.</strong></p>

  <p>
    <a href="https://enclaveagent.tech">Site</a> ·
    <a href="https://github.com/nerdenpad/enclave-developer/blob/main/docs/roadmap.md">Milestones</a> ·
    <a href="https://enclaveagent.tech/dashboard">Dashboard</a> ·
    <a href="https://x.com/enclave_arc">X</a> ·
    <a href="https://t.me/enclavearc">Telegram</a>
  </p>

</div>

---

A completed Enclave request carries a signed receipt. It binds the model, the code, the
input, the output and an attestation reference. You export it, check the signature in the
browser, and read whether the configured contracts accepted and anchored it.

NEAR is the selected GPU inference provider. **The receipt says what was signed,
and the status page reports the deployed network and completed evidence.** Payment
and provider verification are separate checks.

### Release status

The backend runs in production mode with a historically accepted NEAR + Arc
release manifest. New payment/inference admission is blocked pending review of
the current provider workload. The approved price is **0.10 USDC per request**.
Real GPU inference, signed receipts and Arc settlement/anchoring passed historical
acceptance on 1 October. Web QA fixes were deployed on 3 October 2026.
Manual wallet acceptance is reopened after an OKX regression report; a real
retest is still pending. The earlier owner confirmation
on 3 October 2026 remains in the
[acceptance history](https://github.com/nerdenpad/enclave-developer/blob/main/docs/release-progress.md#manual-wallet-regression--3-october-2026).
The full E1 launch remains open pending current provider acceptance, that retest
and live failure acceptance.

What is live and what is still open is published in the
[roadmap](https://github.com/nerdenpad/enclave-developer/blob/main/docs/roadmap.md).

### Three decisions worth knowing

**Rejected evidence stops the request.** Unavailable verification or rejected CPU/GPU
evidence does not fall through to an unverified provider. The request ends.

**A signature is not a hardware proof.** A valid receipt shows that the configured signer
signed those hashes. It does not, by itself, prove the signer ran in a TEE.

**The status page reports the deployed path.** It distinguishes the network, payment
mode, model and completed evidence.

### Repositories

**[enclave-developer](https://github.com/nerdenpad/enclave-developer)** — the frontend,
the backend and the contracts, together on `main`.

<sub>NEAR GPU inference · Arc Mainnet USDC · Signed receipts · Public verification</sub>
