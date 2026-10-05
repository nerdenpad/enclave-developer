# Roadmap

Status reviewed on 5 October 2026. Reviewed provider policy v6 and its accepted NEAR + Arc release manifest are installed. Operator acceptance passed on 4 October. The owner now reports one successful 0.10 USDC wallet request, a correct answer and independent receipt/Arc-anchor checks. Fixes for old-session recovery, login messages and browser CI are implemented and passed local validation; a GitHub browser rerun, manual recovery checks and E1 operational acceptance remain open. Milestones describe delivery and acceptance evidence, not estimated launch dates.

| Milestone | Status | Completion evidence |
| --- | --- | --- |
| Connected frontend and backend | Implemented | Real hosted inference, signed receipts, Arc anchoring and persistent owner history |
| Hosted production deployment | Backend ready on 4 October | Accepted manifest/policy v6, archived and fresh startup checks, public HTTPS readiness at 10:05 UTC; approved price 0.10 USDC per request |
| Receipt verification | Implemented | Public `/verify` page, local signature checks and optional contract/policy/anchor checks |
| Deployment transparency | Implemented | Public `/status` page with configured network, model, policy and limits |
| Hosted inference acceptance | Passed under policy v6 on 4 October | Fresh CPU/GPU, exact reviewed workload, TLS and provider signature checks; complete `READY` response; bounded attestation-only candidate admission |
| Public-chain settlement | Accepted | Arc `5042`, real USDC, four accepted calls totalling 0.40 USDC; confirmed settlements and receipt anchors |
| Wallet connections | One owner-reported paid pass; recovery fixes locally validated | Owner reports a successful paid wallet journey on 5 October; recovery/login fixes passed local validation and still need manual recovery checks; historical evidence is retained in [release progress](release-progress.md) |
| Production user access | Implemented | Wallet sign-in, scoped sessions, owner history and authenticated receipt export |
| E1 operational acceptance | Open | Old-session recovery regression, browser CI, live settlement interruption/recovery, signer rotation and model revocation; see [E1 acceptance](e1-release.md) |

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
