# E1 release acceptance

E1 status: **open**. Arc Mainnet contracts are deployed and the API supports authorized settlement; public browser checkout remains disabled. Hosted inference and a small real-USDC browser payment still need acceptance with strict verification. A GitHub push is source delivery, not deployment by itself.

## Available now

- `/dashboard`: encrypted requests, explicit development payment confirmation, signed receipts and persisted owner history.
- `/verify`: import a single exported receipt, check its EIP-712 signature locally, then optionally check contract acceptance, model policy binding and the anchor event through an explicitly selected RPC.
- `/status`: public network, model, gateway policy, signer, verifier, configured token, price and inference limits. No API key is needed.
- NEAR managed inference with remote CPU/GPU evidence verification. Hosted-path acceptance remains separate.

## Acceptance matrix

| Requirement | Current evidence | Remaining work before release |
| --- | --- | --- |
| Public HTTPS prompt flow | Hosted pilot, HTTPS and a separate non-admin pilot API key; local browser tests | Production user authentication and acceptance on the final infrastructure |
| Composite attestation and protected key release | NEAR provider verification is implemented | Complete a fresh hosted request under the reviewed policy and verify its evidence independently |
| Signed inference receipt | Receipt versions 1/2; model/code/input/output/attestation hashes and signature checked | Prove the configured signer and request path on the accepted deployment |
| On-chain verification and policy | Contracts and isolated Anvil acceptance; public verifier UI; Arc Mainnet contracts deployed | Confirm policy bindings, signer, anchoring and confirmations on Arc |
| USDC without duplicate charge/execution | Arc contracts deployed; API `authorized` on `5042`; relay funded; browser checkout flag still false | One accepted small real-USDC browser payment with restart/recovery evidence; then enable the public checkout flag |
| Verify receipt page | Public `/verify`, local checks plus RPC contract/policy/anchor checks | Repeat checks against the accepted production network |
| Production mode | The process still rejects `NODE_ENV=production` | Complete the accepted request/payment path and validate release configuration before changing the guard or label |
| Public runtime details | `/status`, no credentials required | Publish the accepted production deployment and its operator-reviewed trust roots and limits |

## Infrastructure inputs

The operator must provide the final hosting configuration, production RPC capacity and confirmation policy, approved payment price, funded wallet roles, and a tested website authentication model. Public network parameters and read-only preflight are described in [Arc deployment](arc-deployment.md).

Do not put provider keys, deployer keys, CVM keys, RPC credentials or deployment profiles in Git. Existing `.env*.example` files are templates only.

## Deployment sequence

1. Complete one hosted inference with strict provider evidence checks enabled and verify the receipt independently.
2. Confirm the approved model, code, policy and signer on Arc. Verify token, domain and relay routing rules; never use local bootstrap approval on an external network.
3. Configure the site and `/api` on one HTTPS origin with user authentication, request limits and persistent databases.
4. Exercise a small, approved paid request; verify its receipt and anchor; restart during uncertain payment/inference states and confirm no second debit or generation.
5. Include model revocation, signer rotation, rejected evidence and chain reorganization in acceptance.
6. Publish the domain, network/contracts, model, policy versions, known limits and acceptance evidence. Only then enable the production CTA and describe E1 as live.

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
