# Scanner policy

The [security workflow](../workflows/security.yml) runs on push, pull request and manual dispatch with read-only repository permissions. It does not use deployment credentials, contact the inference provider, sign transactions or run paid requests. No scheduled or live-service check is configured.

## Secret history

Gitleaks 8.30.1 scans every fetched Git revision with the built-in rules, `--redact=100` and inline allow comments disabled. There are no directory, commit or detector-wide exemptions. The exact fingerprints in [gitleaksignore](gitleaksignore) cover 29 reviewed historical findings:

- Public Anvil development keys in the environment example, isolated integration runner and relay-key rejection test.
- Disposable localhost TLS credentials in `near-provider.test.ts`, explicitly identified there as test-only.
- A synthetic hex value used to test secret-field detection.
- Public signed attestation statements in `glm-public-2026-09-19.json`; these are evidence fixtures, not bearer credentials for an API.

A fingerprint includes the original commit, path, detector and line. A new finding is not automatically exempt. Review new findings privately; rotate genuine credentials before considering history cleanup. Do not add a broad path exclusion or baseline report to hide a real leak.

## Application analysis

Semgrep 1.179.0 runs six checked-in rules covering disabled TLS checks, dynamic JavaScript execution, shell-enabled process calls and unsafe Python deserialization. Targets are backend apps, packages and infrastructure code, frontend source and developer scripts. Dependencies, private files, generated environments, fixtures and test code are excluded from the production scan. Positive and negative fixtures are checked separately by exact result and line; empty scans, parse errors and a successful process without expected detections fail the check.

These focused rules do not provide complete application, data-flow or cryptographic analysis. Extend the rules with a positive and negative fixture when adding a new risk class. The scanner uses local rules with telemetry and version checks disabled.

## Solidity analysis

Slither 0.11.6 analyzes all contract source using solc 0.8.28, optimizer runs 200 and `viaIR`, matching the project compiler settings. All detectors remain enabled. Findings confined to mocks, external libraries, tests or deployment scripts are excluded from the release-source gate. Low, informational and optimization findings remain visible in the summary; unreviewed High or Medium findings fail CI.

[slither-triage.json](slither-triage.json) records individual reviewed findings with an element fingerprint, exact normalized source hashes, rationale and supporting tests. A changed source hash, changed finding, duplicated entry or unused exception fails the gate and requires review. No reentrancy detector is disabled. Code-bound accepted findings must not be described as an independent audit or proof of unchanged deployed bytecode.

ModelRegistry listing now has a shared reentrancy guard and callback-token regressions. This source improvement does not modify previously deployed contracts. Deployments must retain their separate release acceptance and governance review.

The [invariant coverage map](invariants.md) links economic, replay, registry, durable nonce and wallet quota claims to specific regressions and records their integration limits.

## Tool updates and reports

Existing CI Actions are pinned to full official commit SHAs. Foundry stays at 1.8.1; its Docker fallback includes an immutable image digest. Gitleaks and solc downloads are verified against the hashes in [tool-pins.json](tool-pins.json). [requirements-linux.lock](requirements-linux.lock) pins all scanner dependencies and wheel hashes for Linux x86_64, Python 3.12.10 or later in the 3.12 series; it does not replace the inference runtime's dependency policy.

The isolated integration Compose file pins PostgreSQL 16.15, Redis 7.4.11 and Anvil/Foundry 1.8.1 to official registry index digests. Update the version and digest together after checking the supported platform manifest. A registry metadata lookup does not establish that the container integration tests ran. Application dependency updates follow the [dependency review policy](../../docs/dependency-policy.md).

Update versions, hashes and rule fixtures together, review upstream release changes and run the scanner jobs before merging. Raw reports and scanner diagnostics remain in ignored `.local/security-results/`; CI publishes only count summaries. Never upload raw scanner output or unredacted findings as public artifacts.

Local commands from the repository root:

```sh
python scripts/security/run-security.py install-gitleaks
python scripts/security/run-security.py secrets
python -m pip install --require-hashes --only-binary=:all: -r .github/security/requirements-linux.lock
python -m unittest discover -s scripts/security -p 'test_*.py'
python scripts/security/run-security.py semgrep-rules
python scripts/security/run-security.py semgrep
python scripts/security/run-security.py install-solc
python scripts/security/run-security.py slither
```

Commands preserve existing reports and refuse to overwrite them. Use a fresh ignored results directory or move the previous reports before a new run. On Windows, scanner availability alone does not prove execution succeeded; the Semgrep native engine can fail before producing JSON. Treat that as an unresolved validation error and require the Linux CI job to pass.
