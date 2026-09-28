# Roadmap

Status reviewed on 28 September 2026. Milestones describe delivery and acceptance evidence, not estimated launch dates.

| Milestone | Status | Completion evidence |
| --- | --- | --- |
| Connected frontend and backend | Implemented | Local integration evidence for a model response, signed receipt, local-chain anchoring and persistent history |
| Public pilot | Available with limits | Website, API and HTTPS; hosted inference still requires a fresh accepted request |
| Receipt verification | Implemented | Public `/verify` page, local signature checks and optional contract/policy/anchor checks |
| Deployment transparency | Implemented | Public `/status` page with configured network, model, policy and limits |
| Hosted inference acceptance | Pending | Successful strict CPU/GPU verification, model response and independently checked receipt on the hosted path |
| Public-chain settlement | Configured; public checkout disabled | Arc `5042` contracts and authorized API settlement; one small real-USDC browser payment and recovery check remain |
| Wallet connections | Configured | Browser wallets, Arc switching and WalletConnect; real-wallet approval and payment compatibility still need acceptance |
| Production user access | Pending | Deployed user authentication and receipt ownership checks |
| E1 release | Open | Complete the hosted inference and Arc USDC acceptance journey; see [E1 acceptance](e1-release.md) |

## Next product features

The following six features can be built from existing receipt, payment, model and status data. Public wording must follow the actual network and deployment evidence.

| Feature | Scope | Acceptance condition |
| --- | --- | --- |
| Public anchored-receipt count | Read-only count and site widget | Counts only confirmed Arc anchors; local Anvil and pending records are excluded |
| Receipt explorer link | URL beside an anchor transaction | Appears only for receipts bound to Arc `5042` and a validated transaction hash |
| Public model registry | Read-only page from existing model listings | Shows model hash, code hash and current active/revoked state without private fields |
| Receipt CSV export | Download beside JSON export | Exports the same authorized rows; no prompt, output or secrets |
| Payment ↔ receipt navigation | Links in both dashboard views | Uses the stored receipt hash; absent links remain absent while a payment is pending |
| Status update history | Dated updates on `/status` from a reviewed file | Deployment claims are published only after their evidence is checked |

Later work: a release-manifest badge requires a trustworthy comparison of deployed bytes with a reviewed Git revision; a public latency metric needs bounded production telemetry; a receipt webhook needs authentication, delivery retries and network restrictions; and a revocation-speed claim needs daily measured acceptance on the selected chain.
