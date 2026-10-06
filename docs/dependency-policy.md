# Dependency review

Dependency changes are reviewed separately from deployment and provider-policy acceptance. A passing package audit establishes the result for that dependency graph and advisory catalogue at the time of the check.

## Updating dependencies

Keep direct runtime versions exact and commit the associated lockfile. Review package provenance, upstream release notes, advisory scope and the transitive diff before accepting an update. A routine update waits at least seven days after upstream publication; record the release date and the reason for an exception in the review. A security fix can bypass that waiting period when the advisory and patched version are verified. This waiting period is a review requirement, not a timer enforced by npm.

Use a clean source snapshot for validation. Run `npm ci`, `npm audit --audit-level=moderate`, the relevant tests and typecheck in both `_backend` and `frontend`. Run the frontend production build. Do not use `npm audit fix --force`, disable peer checks, weaken the audit threshold or accept unrelated lockfile changes to make CI pass. The main workflow audits both dependency graphs immediately after installation.

Python packages for the NEAR verifier have a separate Linux wheel hash lock and installation procedure in [the verifier guide](../_backend/infra/near/README.md). Review the complete transitive closure and wheel hashes when changing its four direct package pins. NVIDIA verifier binaries, model images and GPU drivers retain their separate provider-policy review; the Python package lock does not validate them.

## Reviewed update — 7 October 2026

The following security fixes are exceptions to the routine waiting period:

| Package | Reviewed version | Upstream advisory |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | `1.31.0` | [GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h) |
| `source-map-js` | `1.2.2` | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| `shell-quote` | `1.11.0` | [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) |

Fresh installed graphs reported zero npm advisories in both full and production-only audits. MCP transport tests, source-map/PostCSS compatibility checks, backend and frontend typechecks, and the frontend production build passed. This record does not establish a subsequent GitHub CI run or an installation on the hosted service.

## Vendored code limitation

The development coverage path includes `magicast@0.5.5`, whose published bundle contains `source-map-js@1.2.1`. An npm override replaces the external package; it cannot rewrite code bundled inside another package. The upstream package has no newer compatible patch at this review. The repository does not expose `magicast` or accept source maps through the public API; it is used by development tooling. Do not process untrusted indexed source maps through that tooling. Track the upstream fix and repeat the review when it is published. Zero findings from npm do not close this vendored-code limitation.

## Evidence and promotion

Record the exact source commit, tool versions, audit counts and CI run in the release review. Keep raw diagnostics, credentials and private provider evidence outside public artifacts. Update the installed release only from the reviewed source snapshot, and record deployment evidence separately. Deferred product switches stay disabled unless their release is explicitly approved.
