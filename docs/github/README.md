# GitHub presentation

Public pages follow the same shape as [UseCert](https://github.com/UseCert): a short profile, a repository README that states the pilot limits in the opening, and an About box that matches that wording.

## Repository

The root [README](../../README.md) is the public entry point. Detailed setup stays in [Development](../development.md), with [Architecture](../architecture.md) and [Roadmap](../roadmap.md) beside it.

About description:

> Inference with signed receipts. The customer accepted the software gateway as the production host on 26 September 2026 and cancelled the confidential-VM requirement. Arc settlement is configured; hosted inference is waiting on NVIDIA.

Website: https://enclaveagent.tech

Topics: `inference`, `attestation`, `confidential-computing`, `receipts`, `solidity`, `typescript`, `react`.

## Profile

[profile-README.md](profile-README.md) is the overview copied to the public profile README. A user account shows it from a repository named after the account (`nerdenpad/nerdenpad`, `README.md` at the root). An organization would show the same file from `.github` at `profile/README.md`. Putting that path inside this repository does not create the overview.

Pin `enclave-developer`. Keep the frontend and backend together on `main`.

## At release

Update the dated pilot status in the repository README, the profile README, the roadmap and the E1 acceptance document from the same deployment evidence. Publish a tagged release only when its stated acceptance criteria pass.

The public view should distinguish shipped behavior, current limitations and planned work. No license has been added.
