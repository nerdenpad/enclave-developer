# GitHub presentation

Prepared content for the current repository and a future Enclave organization profile.

## Repository

The root [README](../../README.md) is the public entry point. Detailed setup is in [Development](../development.md), with separate [Architecture](../architecture.md) and [Roadmap](../roadmap.md) documents.

Suggested About description:

> Inference with signed receipts, attestation checks and on-chain verification. Software pilot.

Website: https://enclaveagent.tech

Topics: `inference`, `attestation`, `confidential-computing`, `receipts`, `solidity`, `typescript`.

These are suggested metadata, not changes already applied to GitHub.

## Organization profile

The [profile draft](profile-README.md) is ready to copy to `profile/README.md` in an organization's public `.github` repository once the Enclave organization is chosen. Putting it in this project's `.github/profile/` would not create an organization overview.

Pin the combined repository and use the existing Enclave logo as the organization avatar. Keep the frontend and backend together on `main`. Separate repositories are only needed when they have an independent development and release lifecycle.

## At release

Update the dated pilot status in the repository README, profile draft, roadmap and E1 acceptance document from the same deployment evidence. Publish a tagged release only when its stated acceptance criteria pass. Attach the matching walkthrough and link the deployed network, contracts, model and policy versions.

The public view should distinguish shipped behavior, current limitations and planned work. License terms and a private security-reporting channel still need owner decisions before a public source release. No license or contact address has been invented in this draft.
