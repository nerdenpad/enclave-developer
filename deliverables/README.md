# Enclave integration demonstration

Recorded September 21, 2026. `Enclave-Demo-2026-09-21.mp4` is a two-minute browser recording with English captions and no narration. It uses the connected frontend and backend, including a live NEAR inference request. The model response and transaction records are real; no responses are substituted in the recording.

The walkthrough connects a workspace, reads the active model, creates a spending mandate, encrypts a prompt, approves a payment challenge, verifies the response and receipt, shows blockchain anchoring, exports audit metadata and reloads the persisted history.

| Component | Demonstrated environment |
| --- | --- |
| Inference | NEAR remote GPU, with backend attestation and provider signature checks |
| Gateway and receipt signer | Local software development environment |
| Data and jobs | PostgreSQL, Redis and the receipt anchoring worker |
| Payment | Local Anvil chain 31337, test USDC |
| Browser verification | AES-GCM, input/output hashes, EIP-712 receipt signature and typed hash |

Validation completed: 58 frontend unit tests, 11 browser tests, 140 focused backend API tests, five PostgreSQL integration tests and 21 demo-bootstrap tests. TypeScript checks and the frontend production build passed. The successful recorded journey reported no browser runtime errors.

This is an integration demonstration, not a production deployment. The gateway does not hold keys in a hardware enclave. The dashboard does not submit real-network wallet authorizations or start autonomous agent jobs. NEAR usage is billed separately from the local test payment. Earlier attempts encountered intermittent provider verification/transport failures. Their precise cause was not established; public attestation rechecks passed. The final recorded request passed on its first attempt with all checks retained.

Source folders are `../frontend` and `../_backend` within this combined repository. The root README describes shared startup; application-specific instructions remain in their own directories. The original hosted Lovable site is independent and has not been updated by these changes. Credentials and runtime state are excluded from Git. The video is a standalone file and does not need the local services to play.
