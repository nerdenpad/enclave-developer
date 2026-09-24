# Roadmap

Status reviewed on 24 September 2026. Milestones are tied to acceptance evidence rather than estimated launch dates.

| Milestone | Status | Completion evidence |
| --- | --- | --- |
| Connected frontend and backend | Implemented | Local walkthrough with NEAR output, signed receipt, local-chain anchoring and persistent history |
| Public software pilot | Partially available | Website, API and HTTPS work; hosted inference remains blocked by NVIDIA NRAS HTTP 403 |
| Receipt verification | Implemented | Public `/verify` page, local signature checks and optional contract/policy/anchor checks |
| Deployment transparency | Implemented | Public `/status` page with configured network, model, policy and limits |
| Hosted inference acceptance | Blocked | Successful strict CPU/GPU verification, model response and independently checked receipt from the hosted path |
| Confidential gateway and key custody | Pending infrastructure and implementation | Accepted hardware measurements, protected key release, tamper rejection and encrypted restart recovery |
| Public-chain settlement | Pending network selection and acceptance | Reviewed contracts, real USDC, browser wallet authorization and restart/recovery tests without duplicate charge or execution |
| Production user access | Pending | Deployed user authentication and receipt ownership checks |
| E1 release | Not released | All eight requirements in the [acceptance matrix](e1-release.md) pass on the final deployment |

## Next milestone

Resolve NVIDIA attestation-service access from the hosting network, review any expired provider policy against fresh evidence, then run the hosted inference journey with strict verification enabled. A successful local demonstration does not close this milestone.

## After pilot acceptance

Move gateway key custody into an approved confidential runtime, select the settlement network and complete user authentication. Migration to Phala is a planned hosting option, subject to funding and hardware acceptance; it is not part of the current deployment.

Release documentation will record the deployed code revision, network, contract addresses, model and reviewed policy versions alongside the acceptance evidence. The production label remains gated on that evidence.
