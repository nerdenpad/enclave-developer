# Roadmap

Status reviewed on 3 October 2026. The backend runs in production mode with a historically accepted NEAR + Arc release manifest. New payment/inference admission is currently blocked pending strict review and fresh acceptance of the current provider workload. Web QA fixes were deployed on 3 October; manual OKX retest remains pending. Milestones describe delivery and acceptance evidence, not estimated launch dates.

| Milestone | Status | Completion evidence |
| --- | --- | --- |
| Connected frontend and backend | Implemented | Real hosted inference, signed receipts, Arc anchoring and persistent owner history |
| Hosted production deployment | Installed; admission blocked | HTTPS website/API, historical accepted release manifest and strict startup checks; approved price 0.10 USDC per request; current workload review remains open |
| Receipt verification | Implemented | Public `/verify` page, local signature checks and optional contract/policy/anchor checks |
| Deployment transparency | Implemented | Public `/status` page with configured network, model, policy and limits |
| Hosted inference acceptance | Historical pass; current review open | Strict CPU/GPU, reviewed workload, TLS and provider signature checks passed on 1 October; third paid request returned complete final content; current provider admission is blocked |
| Public-chain settlement | Configured; new admission blocked | Arc `5042`, real USDC, three historical accepted calls totalling 0.30 USDC; confirmed settlements and receipt anchors |
| Wallet connections | Retest pending | WalletConnect operator protocol/browser journey passed on 1 October; web fixes deployed on 3 October; manual acceptance reopened after an OKX failure report; earlier 3 October owner confirmation retained in [release progress](release-progress.md#manual-wallet-regression--3-october-2026) |
| Production user access | Implemented | Wallet sign-in, scoped sessions, owner history and authenticated receipt export |
| E1 operational acceptance | Open | Current provider workload review and fresh acceptance, real manual OKX retest, live settlement interruption/recovery, signer rotation and model revocation; see [E1 acceptance](e1-release.md) |

## Released product features

The following six features use existing receipt, payment, model and status data. Public counts and links are scoped to the configured Arc deployment.

| Feature | Scope | Acceptance condition |
| --- | --- | --- |
| Public anchored-receipt count | Read-only count and site widget | Counts only confirmed Arc anchors; local Anvil and pending records are excluded |
| Receipt explorer link | URL beside an anchor transaction | Appears only for receipts bound to Arc `5042` and a validated transaction hash |
| Public model registry | Read-only page from existing model listings | Shows model hash, code hash and current active/revoked state without private fields |
| Receipt CSV export | Download beside JSON export | Exports the same authorized rows; no prompt, output or secrets |
| Payment ↔ receipt navigation | Links in both dashboard views | Uses the stored receipt hash; absent links remain absent while a payment is pending |
| Status update history | Dated updates on `/status` from a reviewed file | Deployment claims are published only after their evidence is checked |

Later work: a release-manifest badge requires a trustworthy comparison of deployed bytes with a reviewed Git revision; a public latency metric needs bounded production telemetry; a receipt webhook needs authentication, delivery retries and network restrictions; and a revocation-speed claim needs daily measured acceptance on the selected chain.
