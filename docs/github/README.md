# GitHub presentation

Public pages follow the same shape as [UseCert](https://github.com/UseCert): a short profile, a repository README that states the production configuration, current admission limits and remaining E1 acceptance in the opening, and an About box that matches that wording.

## Repository

The root [README](../../README.md) is the public entry point. Detailed setup stays in [Development](../development.md), with [Architecture](../architecture.md) and [Roadmap](../roadmap.md) beside it.

About description:

> NEAR + Arc inference with signed receipts. Provider v6 and paid backend acceptance passed on 4 October 2026. Approved tariff: 0.10 USDC/request; E1 wallet and operational acceptance remain open.

Reviewed provider policy v6, one fresh paid EOA request, complete response, receipt and confirmed Arc anchor passed on 4 October 2026. On 5 October, the owner reported one successful paid wallet request, a correct answer and independent receipt/anchor checks. Fixes for stale OKX sessions, login messages and browser CI are implemented and passed local validation; a GitHub browser rerun and manual recovery checks remain pending. Live settlement interruption, signer rotation and model revocation acceptance remain open. Dated evidence and historical regressions are retained in [release progress](../release-progress.md). Keep this distinction in the public release status.

Website: https://enclaveagent.tech

Topics: `inference`, `attestation`, `confidential-computing`, `receipts`, `solidity`, `typescript`, `react`.

## Profile

[profile-README.md](profile-README.md) is the overview copied to the public profile README. A user account shows it from a repository named after the account (`nerdenpad/nerdenpad`, `README.md` at the root). An organization would show the same file from `.github` at `profile/README.md`. Putting that path inside this repository does not create the overview.

Pin `enclave-developer`. Keep the frontend and backend together on `main`.

## At release

Update the dated release status in the repository README, the profile README, the roadmap and the E1 acceptance document from the same deployment evidence. Publish a tagged release only when its stated acceptance criteria pass.

The public view should distinguish shipped behavior, current limitations and planned work. No license has been added.
