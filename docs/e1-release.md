# E1 release acceptance

E1 status: **open**. The customer accepted the software gateway at https://enclaveagent.tech as the production host on 26 September 2026 and cancelled the confidential-VM requirement. Keys stay in software. Arc Mainnet contracts are deployed and the API uses authorized settlement; public browser checkout stays disabled. Hosted inference is waiting on NVIDIA: NRAS returns HTTP 403 to the VPS, and strict verification stays enabled. A GitHub push is source delivery, not deployment by itself.

## Available now

- `/dashboard`: encrypted requests, explicit development payment confirmation, signed receipts and persisted owner history.
- `/verify`: import a single exported receipt, check its EIP-712 signature locally, then optionally check contract acceptance, model policy binding and the anchor event through an explicitly selected RPC.
- `/status`: public network, model, gateway policy, signer, verifier, configured token, price and inference limits. Software key custody is explicitly disclosed. No API key is needed.
- NEAR managed inference with remote CPU/GPU evidence verification. This does not establish confidential execution or key custody of our gateway.

## Acceptance matrix

| Requirement | Current evidence | Remaining work before release |
| --- | --- | --- |
| Public HTTPS prompt flow | Hosted pilot, HTTPS and a separate non-admin pilot API key; local browser tests | Production user authentication and acceptance on the final infrastructure |
| Composite attestation and protected key release | NEAR provider verification; software gateway accepted by the customer on 26 September 2026 | Confidential VM is no longer a release requirement. Hosted GPU attestation is still blocked by NVIDIA HTTP 403. |
| Signed inference receipt | Receipt versions 1/2; model/code/input/output/attestation hashes and signature checked | Prove the production signer and request path on the accepted hardware |
| On-chain verification and policy | Contracts and isolated Anvil acceptance; public verifier UI; Arc Mainnet selected | Approve policies, deploy contracts on Arc, bind signer and record addresses; test anchoring and confirmations there |
| USDC without duplicate charge/execution | Arc contracts deployed; API `authorized` on `5042`; relay funded; browser checkout flag still false | One accepted small real-USDC browser payment with restart/recovery evidence; then enable the public checkout flag |
| Verify receipt page | Public `/verify`, local checks plus RPC contract/policy/anchor checks | Repeat checks against the accepted production network |
| Production mode | Software host accepted; the process still rejects `NODE_ENV=production` | The guard means "hardware TEE adapter", which is no longer the release rule. Leave it in place until the status it would publish matches Arc USDC settlement and a completed hosted inference. Do not remove it only to print a production label. |
| Public runtime details | `/status`, no credentials required | Publish the accepted production deployment and its operator-reviewed trust roots and limits |

## Infrastructure inputs

A Debian 12 VPS (8 vCPU, 16 GB RAM) hosts the accepted software gateway at `enclaveagent.tech`, with HTTPS and automatic certificate renewal. Arc Mainnet is selected for real USDC; funded deployment and relay wallets have not been supplied. NEAR remains the selected GPU provider. See [the single-server runbook](../infra/pilot/README.md).

The operator must supply:

1. Production hosting and a customer-approved resource budget. The pilot already has a domain, DNS and TLS ingress.
2. Confidential VM access is no longer required. The customer cancelled that requirement on 26 September 2026. The accepted host is the current software gateway on the VPS.
3. Production RPC capacity and confirmation/finality policy for the selected Arc Mainnet, funded deployment/relay wallets and governance addresses. Public network/token parameters and the read-only preflight are recorded in [Arc deployment](arc-deployment.md).
4. An authentication model for website users and receipt ownership. The current operator API-key field is a development facility.

Do not put provider keys, deployer keys, CVM keys, RPC credentials or deployment profiles in Git. Existing `.env*.example` files are templates only.

## Deployment sequence

1. Restore NVIDIA attestation access from the VPS and complete one hosted inference with strict verification still enabled. A 403 response is not a completed request.
2. Keep the software gateway as the accepted host. Do not treat cancellation of the confidential-VM requirement as hardware custody.
3. Deploy contracts on Arc and bind the approved model, code, policy and the software signer. Verify the USDC token, domain and relay routing rules. Do not use local bootstrap approvals on an external network.
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
