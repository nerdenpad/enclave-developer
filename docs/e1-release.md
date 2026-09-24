# E1 release acceptance

E1 status: **not released**. A software pilot is hosted at https://enclaveagent.tech. It is configured for NEAR inference, software gateway keys and local-chain test settlement. As of 24 September 2026, hosted inference is blocked by NVIDIA NRAS HTTP 403 from the VPS; strict verification remains enabled. A GitHub push is source delivery, not deployment by itself.

## Available now

- `/dashboard`: encrypted requests, explicit development payment confirmation, signed receipts and persisted owner history.
- `/verify`: import a single exported receipt, check its EIP-712 signature locally, then optionally check contract acceptance, model policy binding and the anchor event through an explicitly selected RPC.
- `/status`: public network, model, gateway policy, signer, verifier, configured token, price and inference limits. Software key custody is explicitly disclosed. No API key is needed.
- NEAR managed inference with remote CPU/GPU evidence verification. This does not establish confidential execution or key custody of our gateway.

## Acceptance matrix

| Requirement | Current evidence | Remaining work before release |
| --- | --- | --- |
| Public HTTPS prompt flow | Hosted pilot, HTTPS and a separate non-admin pilot API key; local browser tests | Production user authentication and acceptance on the final infrastructure |
| Composite attestation and protected key release | NEAR provider verification; software gateway | Provision a customer-controlled confidential VM; implement its hardware adapter, measurement-bound key release and encrypted recovery; verify negative cases on that hardware |
| Signed inference receipt | Receipt versions 1/2; model/code/input/output/attestation hashes and signature checked | Prove the production signer and request path on the accepted hardware |
| On-chain verification and policy | Contracts and isolated Anvil acceptance; public verifier UI | Choose chain and approved policies, deploy contracts, bind signer and record addresses; test anchoring and confirmations there |
| USDC without duplicate charge/execution | MockUSDC, EIP-3009/x402 and recovery tests | Verify the real token domain/ABI, fund test wallets, implement the browser wallet authorization flow and exercise real-network restart/recovery |
| Verify receipt page | Public `/verify`, local checks plus RPC contract/policy/anchor checks | Repeat checks against the accepted production network |
| Production mode | Correctly rejected by the current software adapter | Replace software custody and pass hardware/deployment acceptance; do not remove the guard as a shortcut |
| Public runtime details | `/status`, no credentials required | Publish the accepted production deployment and its operator-reviewed trust roots and limits |

## Infrastructure inputs

As of 24 September 2026, a Debian 12 VPS (8 vCPU, 16 GB RAM) hosts the software pilot at `enclaveagent.tech`, with HTTPS and automatic certificate renewal. No confidential VM or selected real-USDC network has been supplied. NEAR remains the selected GPU provider. See [the single-server pilot runbook](../infra/pilot/README.md) for hosting without an E1 production claim.

The operator must supply:

1. Production hosting and a customer-approved resource budget. The pilot already has a domain, DNS and TLS ingress.
2. Confidential VM access for our own container workload, CPU evidence format/trust roots, measured image/configuration policy, a key derivation/release interface and durable encrypted storage. A managed inference API key alone does not supply these capabilities.
3. The EVM network, reviewed RPC, required confirmation/finality policy, real USDC address and EIP-712 domain, funded deployment/relay wallets and governance addresses.
4. An authentication model for website users and receipt ownership. The current operator API-key field is a development facility.

Do not put provider keys, deployer keys, CVM keys, RPC credentials or deployment profiles in Git. Existing `.env*.example` files are templates only.

## Deployment sequence

1. Build the gateway image for the selected CVM runtime and record its immutable digest. Provision its attestation and key-release adapter; reject software or unknown adapters in production.
2. Verify fresh CPU evidence, measured workload/configuration, key-release binding and restart recovery. Tampering, expired evidence, unapproved measurements and unavailable key release must stop execution before secrets are released.
3. Deploy contracts on the selected network and bind the approved model/code/policy and hardware-held signer. Verify the USDC token/domain and relay routing rules. Do not use local bootstrap approvals on an external network.
4. Configure the site and `/api` on one HTTPS origin, server-side authentication, request limits and persistent databases. The Vite development proxy is not a public deployment configuration.
5. Exercise a paid request on the deployed path; verify the receipt independently; anchor it; restart during uncertain payment/inference states and confirm no second debit or generation. Include model revocation, signer rotation, rejected evidence and chain reorganization cases.
6. Publish the domain, network/contracts, model, both gateway and remote-provider policy versions, known limits and acceptance evidence. Only then enable the production CTA and describe E1 as live.

## Verification commands

From the combined repository root:

```sh
npm run setup
npm run typecheck
npm test
npm run test:browser
npm run build
npm run test:receipt-chain
```

`test:receipt-chain` creates a loopback-only disposable Anvil container with the pinned Foundry image. It deploys actual ModelRegistry and AttestationVerifier contracts, checks a signed receipt and its anchor event, then revokes the model and requires rejection. It stops its own container and does not use project databases, keys, paid inference or a public chain. Run it with a local Docker engine. Its metadata is written under the ignored `frontend/test-results/` directory.

`npm run test:launch` verifies the integrated local services without inference charges. Stop an existing launcher first. Passing these tests does not supply missing production infrastructure or hardware acceptance.

## Receipt verification boundaries

Trust settings must come from an independently approved deployment record, not only from the uploaded receipt. Local signature validation does not contact a gateway. The optional RPC mode is read-only (`eth_call` and chain queries); it never signs or submits a transaction. Uploaded fields are never used as an RPC endpoint or as an implicit trusted signer.

Contract acceptance is evaluated at one displayed block with a reorganization check. A supplied anchor must be a successful canonical transaction with the exact `Verified` event from the trusted contract. Missing or pending anchors remain unconfirmed. Confirmation count is reported without claiming network finality. Unbound registry policies are explicitly marked as missing.

The verifier does not independently validate CPU/GPU quotes, reconstruct private prompt/output bytes, or establish USDC payment. Current signer rotation or model revocation can cause an otherwise historically valid receipt to fail the current contract check. Full historical policy verification is a separate feature.
