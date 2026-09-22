# Completing the NEAR deployment

NEAR remains the selected GPU inference provider. Moving to Phala is not a prerequisite. Full Enclave deployment does require a confidential VM that can run our gateway and agent process, in addition to the managed GPU inference endpoint.

## Account status — 20 September 2026

The current organization has a working inference API key. Its **Dedicated deployment** screen opens a capacity request form; no self-service container deployment or CVM credentials were available there. No request was submitted and no resources were ordered. An inference balance does not establish access to a customer-controlled confidential VM.

NEAR describes customer workloads in confidential VMs separately from standard VMs in [its service terms, sections 13–15](https://near.ai/terms-of-service). Its [private-ml-sdk](https://github.com/nearai/private-ml-sdk#using-dstack-vmm-recommended) describes deploying Docker Compose workloads through dstack VMM. That route requires infrastructure access beyond the inference API key. Availability for this account remains unconfirmed.

## Access needed from NEAR

The deployment must allow our own container image and gateway process in a **CVM with verifiable CPU attestation**. A standard VM or a managed agent interface alone is insufficient. Before provisioning, confirm:

- A deployment endpoint or console, credentials, region and capacity for an arbitrary container workload.
- The attestation format, trust roots, nonce freshness, measured image/configuration and update policy.
- A supported key derivation or key-release interface tied to the approved workload measurement, including restart and upgrade behavior.
- Ingress with TLS key binding, outbound access to the chosen NEAR model endpoint and blockchain RPC, and durable encrypted storage.
- Pricing and the customer's approved spending limit.

The gateway does not need another GPU when it uses the existing remote NEAR GPU endpoint. The customer CVM requirement concerns gateway execution and custody of its session, receipt-signing and agent-state keys.

## Acceptance on the provisioned CVM

Build and pin the Enclave image; verify its CPU evidence and key-release policy before installing secrets. Replace the development software key store with the approved hardware-backed adapter. Keep the existing remote GPU verifier and its reviewed policy independent of the local software TCB lifecycle.

Then test an encrypted inference request, provider proof, payment and receipt anchoring on the selected network; restart and recover the same request without a duplicate charge or generation. Rotate the software policy and reject old sessions. Reject changed measurements, stale collateral, invalid signatures and unavailable key release. Demonstrate that host access outside the CVM cannot recover gateway or agent keys.

`NODE_ENV=production` remains blocked until that adapter and deployment pass acceptance. Software unit tests, local Anvil transactions and a successful remote GPU attestation cannot satisfy this requirement by themselves.

## Other delivery dependencies

Real network deployment still needs the customer's network selection, deployed addresses and funded wallets. Confidential transfers require an actual supported privacy integration. DEX buybacks need an approved router/pool; collateral credit and slashing need defined rules. The specified confidential-compute overhead must be measured on comparable hardware with and without confidential mode.

None of these dependencies requires selecting Phala specifically.
