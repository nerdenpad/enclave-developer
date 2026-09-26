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

Underneath, the hosted gateway still runs in software on an ordinary VPS. NEAR is the
selected remote GPU. **The receipt says what was signed, and the status page says what
that signature does not prove** — hardware custody, payment and a completed hosted
inference are separate claims.

### Production host

On 26 September 2026 the customer accepted the software gateway as the production host
and **cancelled the confidential-VM requirement**. Keys stay in software on the VPS.
That decision does not settle USDC and does not complete a hosted inference.

Hosted inference is waiting on NVIDIA: their attestation service returns HTTP 403 to
the VPS, and strict verification stays on. Settlement is still MockUSDC on a private
chain. Real USDC on Arc is the remaining payment work.

What is live and what is still open is published in the
[roadmap](https://github.com/nerdenpad/enclave-developer/blob/main/docs/roadmap.md).

### Three decisions worth knowing

**Rejected evidence stops the request.** Unavailable verification or rejected CPU/GPU
evidence does not fall through to an unverified provider. The request ends.

**A signature is not a hardware proof.** A valid receipt shows that the configured signer
signed those hashes. It does not, by itself, prove the signer ran in a TEE.

**The status page does not invent a deployment.** Software key custody is named as
software. Where hosted inference has not completed, the page says so instead of implying
a finished confidential deployment.

### Repositories

**[enclave-developer](https://github.com/nerdenpad/enclave-developer)** — the frontend,
the backend and the contracts, together on `main`.

<sub>Software gateway, accepted as the production host. Confidential VM is not required. This deployment does not yet settle real USDC, and hosted inference is waiting on NVIDIA.</sub>
