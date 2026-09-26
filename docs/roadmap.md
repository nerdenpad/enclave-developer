# Roadmap

Status reviewed on 26 September 2026. Milestones are tied to acceptance evidence rather than estimated launch dates. The customer accepted the software VPS gateway as the production host and cancelled the confidential-VM requirement.

| Milestone | Status | Completion evidence |
| --- | --- | --- |
| Connected frontend and backend | Implemented | Local walkthrough with NEAR output, signed receipt, local-chain anchoring and persistent history |
| Public software pilot | Partially available | Website, API and HTTPS work; hosted inference remains blocked by NVIDIA NRAS HTTP 403 |
| Receipt verification | Implemented | Public `/verify` page, local signature checks and optional contract/policy/anchor checks |
| Deployment transparency | Implemented | Public `/status` page with configured network, model, policy and limits |
| Hosted inference acceptance | Blocked | Successful strict CPU/GPU verification, model response and independently checked receipt from the hosted path |
| Confidential gateway and key custody | Cancelled by the customer, 26 September 2026 | The software VPS gateway is the accepted host. Hardware key custody is not a release requirement. |
| Public-chain settlement | Contracts deployed; public checkout still disabled | Arc `5042` UsageMeter and related contracts live; API `authorized`. One accepted small real-USDC browser payment remains. See [Arc configuration](arc-deployment.md) |
| Wallet connections | Browser connection, Arc switching and WalletConnect configured | Hosted check loaded 77 Arc-filtered catalog entries, received a relay response and displayed a cancellable QR code. Real-wallet approval and payment compatibility acceptance remain. See [scope and acceptance](wallet-payments.md) |
| Production user access | Pending | Deployed user authentication and receipt ownership checks |
| E1 release | Open | NVIDIA attestation access and Arc USDC settlement remain. See the [acceptance matrix](e1-release.md). |

## Next milestone

Resolve NVIDIA attestation-service access from the hosting network, review any expired provider policy against fresh evidence, then run the hosted inference journey with strict verification enabled. A successful local demonstration does not close this milestone.

## After the host decision

The customer cancelled confidential-VM custody. Arc contracts and authorized API settlement are in place. Remaining work is NVIDIA attestation access from the VPS, then one accepted browser payment with public checkout still off until then. Migration to Phala is not part of this deployment.

Release documentation will record the deployed code revision, network, contract addresses, model and reviewed policy versions alongside the acceptance evidence. A completed hosted inference and a real USDC payment are still required before those claims are closed.
