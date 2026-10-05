# E1 release acceptance

E1 public launch acceptance: **open**. The backend runs in production mode with reviewed provider policy v6 and its accepted NEAR + Arc release manifest installed on 4 October 2026. A fresh operator EOA request passed strict CPU/GPU verification, signed complete response, 0.10 USDC settlement and canonical Arc receipt anchoring. Production startup passed archived and fresh provider checks; public HTTPS health reported backend and provider readiness at 10:05 UTC. Serving policy version 2 remains registered, approved and activated. The earlier 1 October API and WalletConnect operator browser acceptances remain recorded.

A third **0.10 USDC** test on 1 October returned the complete final answer `READY` with `finish_reason: stop` under provider policy v5. The fourth call on 4 October returned the same complete final answer under reviewed provider policy v6, with thinking enabled and a 512-token cap. After the actual production API restart, completed-result replay returned the exact same payment, receipt, response, settlement and anchor with no additional spend or usage. Aggregate confirmed acceptance usage is **four calls and 0.40 USDC**. The earlier 32-token requests prove the protocol paths, not complete-answer quality.

Public browser checkout is configured at the approved **0.10 USDC per request**; admission still requires fresh verified evidence for each request. On **5 October 2026**, the owner reported one successful paid wallet request, a correct model answer and independent receipt/Arc-anchor checks. That report is separate from the four retained operator transactions; no new aggregate spend is inferred. Fixes for old OKX sessions, stale login messages and browser CI are implemented and passed local validation. A GitHub browser rerun and manual recovery checks remain pending. The earlier failure reports and confirmations are retained in [release progress](release-progress.md). Live settlement interruption, signer rotation and model revocation acceptance remain open.

The selected inference route is experimental direct NEAR using the exact reviewed `<model-label>.completions.near.ai/v1` endpoint. Its experimental label remains visible on `/status`. The selected route must pass pinned provider policy, node CPU/GPU evidence, TLS/signer binding and exact signed transcript checks before acceptance; choosing it does not mark E1 live.

## Available now

- `/dashboard`: encrypted requests, configured network/payment mode, signed receipts and persisted owner history. Public Arc checkout is gated separately from backend readiness.
- `/verify`: import a single exported receipt, check its EIP-712 signature locally, then optionally check contract acceptance, model policy binding and the anchor event through an explicitly selected RPC.
- `/status`: public inference route, reported release stage/readiness, network, model, gateway/provider policy, signer, verifier, configured token, price and inference limits. No API key is needed.
- NEAR managed inference with remote CPU/GPU evidence verification. Four real paid requests passed receipt/Arc verification. The fourth returned a complete final answer under reviewed provider policy v6 on 4 October; its archived evidence and fresh production hardware checks passed. Direct admission permits at most three attestation-only candidate connections, retaining exact policy and verification checks without retrying inference POSTs.

## Acceptance matrix

| Requirement | Current evidence | Remaining work before release |
| --- | --- | --- |
| Public HTTPS prompt flow | Real HTTPS operator browser request on 1 October and provider v6 acceptance on 4 October; owner reports one complete paid wallet request with independent receipt/anchor checks on 5 October | Retest old OKX session recovery after rollout; one paid request does not establish all wallet/browser scenarios |
| Verified NEAR GPU inference | Fresh strict CPU/GPU, exact reviewed node profile, TLS identity and signed transcript checks; fourth request returned complete `READY`/`stop` under provider policy v6 on 4 October | Retain current reviewed policy and complete operational failure acceptance; expiry remains 8 October 14:29:11 UTC |
| Signed inference receipt | Accepted API and browser receipts bind model/code/input/output/attestation hashes; configured signatures verified | Retain verification evidence for subsequent releases |
| On-chain verification and policy | Arc policy v2 approved and activated; real receipt anchor and exact canonical Verified event confirmed with 12 successor blocks | Include model revocation and signer rotation in final release acceptance without losing retained evidence |
| USDC without duplicate charge/execution | Approved tariff of 0.10 USDC; four calls/0.40 USDC with one settlement per intent; 4 October completed-request replay after the production API restart preserved the exact result with unchanged payment and usage; durable dispatch quarantine passed fault tests; the [reported OKX intent](release-progress.md#manual-wallet-regression--3-october-2026) was unsettled at canonical Arc block 24086493 with 12 successor blocks | Complete interruption during live settlement and recovery from that interruption |
| Verify receipt page | Frontend local signature and read-only RPC verification passed for the initial API/browser receipts, policies and anchors; browser receipt dialog and JSON/CSV export passed | Retain independently approved trust settings |
| Production mode | Reviewed manifest/policy v6 and archive installed on 4 October; strict production restart passed archived and fresh hardware checks; public backend and provider readiness true at 10:05 UTC | Keep acceptance and provider policy current; complete remaining E1 launch gates |
| Public frontend delivery | Checkout configured at 0.10 USDC; atomic asset/output installation passed HTTPS JS hash/MIME and canonical page checks; original motion at normal 1× speed and centered desktop/mobile footer verified; browser CI fixes passed local validation | Complete a GitHub browser rerun, retain motion checks and verify stale-session/login recovery after rollout |
| Public runtime details | `/status` and home report deployed stage, Arc, model, policies, signer, price and limits without credentials | Record subsequent acceptance and rollout updates |

## Infrastructure inputs

The operator must provide the final hosting configuration, production RPC capacity and confirmation policy, approved payment price, funded wallet roles, and acceptance of the implemented wallet authentication. Public network parameters and read-only preflight are described in [Arc deployment](arc-deployment.md). The release configuration and acceptance archive are described in [NEAR + Arc release profile](near-arc-release.md).

Do not put provider keys, deployer keys, RPC credentials or deployment profiles in Git. Existing `.env*.example` files are templates only.

## Deployment sequence

1. Configure `NEAR_ENDPOINT_PROFILE=direct-experimental` and the exact canonical model endpoint. Complete one hosted inference with strict provider/node evidence checks enabled, preserve the exact signed transcript and policy bytes, and verify the receipt and provider evidence independently.
2. Confirm the approved model, code, policy and signer on Arc. Verify token, domain and relay routing rules; never use local bootstrap approval on an external network.
3. Configure the site and `/api` on one HTTPS origin with user authentication, request limits and persistent databases.
4. Exercise a small, approved paid request; verify its receipt and anchor; restart during uncertain payment/inference states and confirm no second debit or generation.
5. Include model revocation, signer rotation, rejected evidence and chain reorganization in acceptance.
6. Publish the domain, network/contracts, model, policy versions, known limits and acceptance evidence. Enable reviewed checkout after its own acceptance; describe E1 as live only after the remaining release acceptance is complete.

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
