# Security policy

Report suspected vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/nerdenpad/enclave-developer/security/advisories/new). If the form is unavailable, ask a repository maintainer to enable private vulnerability reporting before sharing technical details. Do not put exploit details, credentials or private receipts in a public issue.

Include the affected commit or deployment, the component, expected and observed behavior, impact and a minimal reproduction using local fixtures. Redact prompts, outputs, access tokens, wallet keys and identifying data. Do not spend funds, test other users' accounts or load-test the public service to produce a report.

Security fixes target the current `main` branch. Earlier snapshots and local preview environments are not maintained releases. Maintainers assess reports and coordinate disclosure after a fix is available; no response-time or bounty commitment is offered here.

The checks in [Security CI](.github/workflows/security.yml) cover secret history and selected application and Solidity risks. Their scope and reviewed findings are documented in the [scanner policy](.github/security/README.md). Passing these checks is not an independent audit or evidence of hardware isolation, payment acceptance or completion of every release scenario.
