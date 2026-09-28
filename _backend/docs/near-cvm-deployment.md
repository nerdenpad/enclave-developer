# Completing the NEAR deployment

NEAR remains the selected GPU inference provider. Moving to Phala is not a prerequisite. Full Enclave deployment does require a confidential VM that can run our gateway and agent process, in addition to the managed GPU inference endpoint.

## Access needed from NEAR

The deployment must allow our own container image and gateway process in a **CVM with verifiable CPU attestation**. A standard VM or a managed agent interface alone is insufficient. Before provisioning, confirm:

- A deployment endpoint or console, credentials, region and capacity for an arbitrary container workload.
- The attestation format, trust roots, nonce freshness, measured image/configuration and update policy.
- A supported key derivation or key-release interface tied to the approved workload measurement, including restart and upgrade behavior.
- Ingress with TLS key binding, outbound access to the chosen NEAR model endpoint and blockchain RPC, and durable encrypted storage.
- Pricing and the customer's approved spending limit.

The gateway does not need another GPU when it uses the existing remote NEAR GPU endpoint. The customer CVM requirement concerns gateway execution and custody of its session, receipt-signing and agent-state keys.

## Acceptance on the provisioned CVM

Build and pin the Enclave image; verify its CPU evidence and key-release policy before installing secrets. Use the approved key-release adapter. Keep the remote GPU verifier and its reviewed policy independent of gateway policy lifecycle.

Then test an encrypted inference request, provider proof, payment and receipt anchoring on the selected network; restart and recover the same request without a duplicate charge or generation. Rotate the gateway policy and reject old sessions. Reject changed measurements, stale collateral, invalid signatures and unavailable key release. Demonstrate that host access outside the CVM cannot recover gateway or agent keys.

`NODE_ENV=production` remains blocked until the deployment passes acceptance. Unit tests, local Anvil transactions and a successful remote GPU attestation cannot satisfy this requirement by themselves.

## Other delivery dependencies

Real network deployment still needs the customer's network selection, deployed addresses and funded wallets. Confidential transfers require an actual supported privacy integration. DEX buybacks need an approved router/pool; collateral credit and slashing need defined rules. The specified confidential-compute overhead must be measured on comparable hardware with and without confidential mode.

None of these dependencies requires selecting Phala specifically.
