# Roadmap

Status reviewed on 3 October 2026. The hosted deployment runs the accepted NEAR + Arc production profile. Milestones describe delivery and acceptance evidence, not estimated launch dates.

| Milestone | Status | Completion evidence |
| --- | --- | --- |
| Connected frontend and backend | Implemented | Real hosted inference, signed receipts, Arc anchoring and persistent owner history |
| Hosted production deployment | Available | HTTPS website/API, accepted release manifest, strict startup checks and public checkout at 0.10 USDC per request |
| Receipt verification | Implemented | Public `/verify` page, local signature checks and optional contract/policy/anchor checks |
| Deployment transparency | Implemented | Public `/status` page with configured network, model, policy and limits |
| Hosted inference acceptance | Passed | Strict CPU/GPU, reviewed workload, TLS and provider signature checks; third paid request returned complete final content |
| Public-chain settlement | Enabled | Arc `5042`, real USDC, three accepted calls totalling 0.30 USDC; confirmed settlements and receipt anchors |
| Wallet connections | Accepted | WalletConnect protocol/browser journey passed; manual wallet acceptance confirmed by the project owner on 3 October 2026 |
| Production user access | Implemented | Wallet sign-in, scoped sessions, owner history and authenticated receipt export |
| E1 operational acceptance | Open | Live settlement interruption/recovery, signer rotation and model revocation; see [E1 acceptance](e1-release.md) |

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
