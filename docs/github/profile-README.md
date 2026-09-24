# Enclave

Inference with signed receipts, attestation checks and on-chain verification.

[Website](https://enclaveagent.tech) · [Dashboard](https://enclaveagent.tech/dashboard) · [Verify a receipt](https://enclaveagent.tech/verify) · [Status](https://enclaveagent.tech/status) · [Roadmap](https://github.com/nerdenpad/enclave-developer/blob/main/docs/roadmap.md)

Enclave gives each completed model request a signed receipt linking the model, code, input, output and attestation reference. Users can export that receipt, check its signature in their browser and query the configured contracts for policy acceptance and anchoring.

### Current stage

Enclave is a software pilot. The gateway runs on an ordinary VPS, NEAR is the selected remote GPU provider, and settlement uses test tokens on a private chain. Gateway keys are not yet held in confidential hardware.

The website is available. As of 24 September 2026, hosted inference is blocked by NVIDIA attestation-service access from the VPS. Strict verification remains enabled. E1 has not been released.

### What to explore

- [Dashboard](https://enclaveagent.tech/dashboard): connected workspace, request flow and receipt history; requires an issued pilot key.
- [Receipt verifier](https://enclaveagent.tech/verify): local signature verification and optional chain checks.
- [Deployment status](https://enclaveagent.tech/status): configured network, model, policy and limits.
- [Release requirements](https://github.com/nerdenpad/enclave-developer/blob/main/docs/e1-release.md): what must pass before production.

### Repository

[enclave-developer](https://github.com/nerdenpad/enclave-developer) contains the frontend, backend, contracts, tests and deployment configuration on `main`.
