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

The backend runs in production mode with reviewed provider policy v6 and an
accepted NEAR + Arc release manifest installed on **4 October 2026**. A fresh
operator EOA request passed strict GPU inference, a complete answer, signed
receipt and **0.10 USDC** settlement/anchoring. Public backend and provider
readiness were true at 10:05 UTC. Every new request still requires fresh
verification. The approved price is **0.10 USDC per request**.
On **5 October 2026**, the owner reported one successful paid wallet request,
including a correct answer and independent receipt/Arc-anchor checks. Fixes for
old OKX sessions, login messages and browser CI are implemented and passed
local validation. A GitHub browser rerun and manual recovery checks remain
pending. The earlier owner confirmation on 3 October remains in the
[acceptance history](https://github.com/nerdenpad/enclave-developer/blob/main/docs/release-progress.md#manual-wallet-regression--3-october-2026).
The full E1 launch remains open pending recovery regression checks and live operational acceptance.

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
