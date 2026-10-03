# NEAR and Arc acceptance operator guide

`accept-near-arc.ts` prepares evidence from one explicitly authorized synthetic request on Arc Mainnet, chain **5042**. Its fixed prompt is `Reply with the single word READY.` The normal execution signs a wallet login and a bounded USDC authorization, opens a payment intent, settles it through the API's relay, and sends one paid completion request. It preserves the request and payment in a private journal before each mutation. It never retries an ambiguous paid completion automatically.

Run commands from `_backend` with the project's installed Node.js 22+ dependencies. Use a separately approved deployment, reviewed release facts, and an existing production provider policy. Passing preflight or unit tests does not establish live hardware or payment acceptance.

**Prepare the plan and credentials.**

The plan is a strict JSON object. Every field below is required; populate it from the reviewed deployment rather than a unit-test fixture.

| Plan field | Required value |
| --- | --- |
| `schemaVersion` | `1`. |
| `release` | The release manifest's public inputs, described below. Omit `acceptance`, `acceptedInference`, and `acceptedPayment`. |
| `providerOrigin` | The exact provider origin, normally `https://cloud-api.near.ai`, without `/v1` or another path. The implemented direct path accepts an exact `https://<host>.completions.near.ai` origin. |
| `walletAuthOrigin` | The exact production HTTPS SIWE origin, equal to `release.origin` and the API's wallet-auth configuration. No path, trailing slash, credentials, query, or fragment. |
| `expectedPriceUnits` | A decimal integer string from `1` through `1000000`, matching the actual runtime inference price in six-decimal USDC units. `1000000` is the ceiling of one USDC, not a default price. |
| `maxOutputTokens` | An explicitly reviewed integer from `1` through `512`. The runtime limit and the signed provider request's `max_tokens` must fit this limit. Reasoning models may require more than 32 tokens to produce final content. The USDC authorization ceiling remains one USDC. |
| `confirmations` | The reviewed transaction depth, an integer from `1` through `1000`. |
| `usdcDomain` | `{ "name": "<reviewed token domain name>", "version": "<reviewed token domain version>" }`, matching the configured USDC contract's on-chain domain separator on chain 5042. |
| `acceptanceValidUntil` | A future UTC ISO timestamp ending in `Z`, within 30 days of the check and no later than the reviewed provider policy's `validUntil`. |

`release` contains `schemaVersion: 1`, `origin`, `chainId: 5042`, `modelId`, `servingImageId`, `tcbVersion`, `modelHash`, `codeHash`, `policyHash`, and the expected receipt `signer`. Its `contracts` object contains the five distinct reviewed addresses `ModelRegistry`, `AttestationVerifier`, `USDC`, `UsageMeter`, and `FeeVault`. Its `providerPolicy` object contains `path`, `sha256`, `version`, `reviewedAt`, `reviewedBy`, and `scope: "production"`. The policy path resolves relative to the plan file. Hashes and addresses must match the running model, application policy, contracts, and signer.

The provider policy must already carry genuine review provenance: `status: "APPROVED"`, `scope: "production"`, `reviewedAt`, and `reviewedBy`. Its exact bytes must match `release.providerPolicy.sha256`; the review metadata and version must also match. Cloud policies need complete gateway profiles and model profiles. The tool does not approve measurements, invent provenance, register or approve a model, or turn a development candidate into an approved policy.

Configure these environment variables in a protected operator environment or a private dotenv file passed with `--env`:

| Variable | Purpose |
| --- | --- |
| `ACCEPTANCE_API_BASE` | The deployed API base, with optional `/api`. HTTPS is required except for exact HTTP loopback hosts `localhost`, `127.0.0.1`, or `[::1]`, for example a local tunnel. URL credentials, other paths, query strings, and fragments are rejected. |
| `ARC_RPC_URL` | The operator's Arc Mainnet RPC endpoint. The runner independently requires chain 5042. |
| `ACCEPTANCE_PAYER_PRIVATE_KEY` | A separately configured EOA payer key, encoded as `0x` plus 64 hex digits. It is required for execution and journal ownership checks during recovery and preparation. An initial preflight can run without it. |
| `NEAR_VERIFIER_PYTHON` | The existing Python interpreter with the dependencies in [requirements.txt](../infra/near/requirements.txt). Required for execution, completed-result replay, and manifest preparation. |
| `NVIDIA_VERIFIER_MODE` | `nras` by default. Explicit `local` mode additionally requires absolute `NVIDIA_NVAT_BINARY` and `NVIDIA_NVAT_LIBRARY` paths and matching reviewed artifact pins in the provider policy. It never selects an automatic fallback. |
| `NEAR_VERIFIER_SCRIPT` | Optional absolute path to an independently reviewed hardware-verifier adapter on the operator workstation. It replaces the script run by the chosen Python interpreter and receives only public hardware evidence. This is trusted operator code, not a setting supplied by a receipt or API response. Production API configuration always uses its built-in verifier. |

An explicit `--env` file overrides the corresponding process environment values. The CLI uses the actual payer's production SIWE wallet session for owner access. It verifies the login's origin, dashboard URI, chain 5042, address, nonce, statement, and timing before signing. It does not use an acceptance API key or fall back to the deployment relay's private key. The payer needs enough USDC for the exact planned price. Signing the later EIP-3009 authorization permits that payment; keep the payer key and authorization private.

**Choose private, durable storage.**

Keep the plan and dotenv file outside the journal's directory. Use one dedicated directory per acceptance run, such as `.local/near-arc-acceptance-run/`, with `state.json` as its journal. That directory must contain only the run's journal, lock, generated artifacts, and recognized temporary files. A shared project directory is rejected. The journal filename must differ from the generated artifact filenames.

Before non-preflight operations, the CLI protects the dedicated directory and existing files. Windows uses protected ACLs allowing the current user SID, SYSTEM, and Administrators; Unix uses directory mode `0700` and file mode `0600`. A protection failure stops the operation. The environment file needs separate protection because it remains outside this directory.

The journal contains a wallet bearer, session wrapping key, ciphertext, payment authorization, and retained result. `inference.json` contains decrypted request/response material and the hardware archive. Keep the entire directory private and outside version control. Console output reports status and identifiers without the payer key, bearer, authorization payload, prompt, or output text.

Retain the exact plan bytes, provider policy bytes, API base, payer, and journal across recovery. Changing their scope makes the journal fail validation. Replacing or deleting the journal loses the controls that tie recovery to the original request; it is not a safe way to retry an uncertain payment.

**Run preflight, then execute once.**

These examples use a plan and dotenv file outside the dedicated run directory:

```powershell
npx tsx scripts/accept-near-arc.ts --plan .local/near-arc-acceptance-plan.json --state .local/near-arc-acceptance-run/state.json --env .local/near-arc-acceptance.env
```

With no mode flag, the runner performs read-only API/RPC preflight. It checks production wallet login configuration, the managed NEAR profile, runtime hashes and price, the reviewed policy, active on-chain TCB approval, contract wiring, token decimals/domain, and payer balance when a key is supplied. It sends no login, settlement, or completion POST. It does not create acceptance evidence or grant release approval.

After the operator has authorized this specific paid request:

```powershell
npx tsx scripts/accept-near-arc.ts --plan .local/near-arc-acceptance-plan.json --state .local/near-arc-acceptance-run/state.json --env .local/near-arc-acceptance.env --execute
```

Execution obtains a SIWE bearer, creates the encrypted session, obtains an unpaid 402 payment challenge, verifies its exact token/recipient/amount, and signs the bounded USDC authorization. The challenge POST creates the intent; the subsequent paid POST is the single normal completion attempt. The signed authorization's value is the planned price, at most `1000000` units. The CLI never raises the price to the cap, creates another payment as recovery, or automatically repeats a POST after uncertainty.

Successful result verification checks the signed receipt, provider signature and transcript, the fixed synthetic input, token cap, and independent archived CPU/GPU verification. A final candidate additionally needs a persisted consumed payment and exact canonical, sufficiently confirmed settlement and receipt-anchor events. `awaiting-anchor` means the private result has been saved but final acceptance evidence is still pending; use saved-result preparation after the anchor is ready.

**Recover without creating a new completion.**

Inspect the original journal and owner records through GET-only API recovery:

```powershell
npx tsx scripts/accept-near-arc.ts --plan .local/near-arc-acceptance-plan.json --state .local/near-arc-acceptance-run/state.json --env .local/near-arc-acceptance.env --recover
```

This mode sends no login, settlement, or inference POST. It may record a proven settlement in the local journal; it does not resume the paid request. It requires the retained wallet session to remain valid. An expired login produces `WALLET_LOGIN_REQUIRED_EXECUTE` instead of silently signing a new login. Treat any ambiguous `*-starting` phase as a recovery condition, not permission to start another run.

If the encrypted result is already saved, recheck it and prepare the candidate without another inference POST:

```powershell
npx tsx scripts/accept-near-arc.ts --plan .local/near-arc-acceptance-plan.json --state .local/near-arc-acceptance-run/state.json --env .local/near-arc-acceptance.env --prepare-manifest
```

Preparation uses the saved result, current owner records, hardware verification, and chain reads. It also requires an existing valid wallet login. Hardware replay can obtain trusted public collateral and keys; GET-only API recovery and manifest preparation are separate from an offline check.

Only when the server already proves the original payment is consumed and the matching signed receipt persisted may the operator explicitly retrieve the completed result:

```powershell
npx tsx scripts/accept-near-arc.ts --plan .local/near-arc-acceptance-plan.json --state .local/near-arc-acceptance-run/state.json --env .local/near-arc-acceptance.env --execute --recover-completed
```

This path verifies the persisted receipt's signature, original session binding, input, release hashes, and payment association before sending a replay POST with the original session, ciphertext, idempotency key, and payment ID. It retrieves the existing idempotent result rather than authorizing a new completion or another settlement. It refuses missing persisted proof and expired inference sessions, requires the replay to return the same receipt hash, and never retries a failed replay automatically. The retained wallet login may be explicitly renewed in this mode. Review the journal phase and server evidence before choosing an execution mode; a missing result alone is insufficient proof that no completion happened.

If a terminated process left `state.json.lock`, first ensure no acceptance runner is operating on that directory. Then explicitly remove only a proven stale lock:

```powershell
npx tsx scripts/accept-near-arc.ts --plan .local/near-arc-acceptance-plan.json --state .local/near-arc-acceptance-run/state.json --unlock-stale
```

`--unlock-stale` cannot be combined with another mode. It sends no API/RPC requests and performs no paid continuation. It removes the unchanged lock only when the recorded PID is definitely absent; active, inaccessible, malformed, or changed locks are refused. Run GET-only `--recover` next. Unlocking a journal does not establish whether its last request completed.

**Review the generated facts before release.**

| Private artifact | Contents |
| --- | --- |
| `state.json` | Durable request, payer/session scope, authorization, phases, saved result, and completion POST count. |
| `inference.json` | Signed receipt and provider proof, decrypted transcript, and archived attestation evidence. |
| `provider-policy.json` | A byte-for-byte copy of the already reviewed provider policy. |
| `release-manifest.candidate.json` | A wrapper with `status: "REVIEW_REQUIRED"`, preparation time, check results, and a nested `manifest`. |

The candidate wrapper is not the release manifest consumed by production validation. After reviewing the recorded hashes, signer, payer, amount, endpoint, policy provenance, receipt, and confirmed transactions, extract its nested `manifest` into a separately reviewed manifest file alongside its referenced `inference.json` and `provider-policy.json`. Preserve the referenced bytes and relative paths. Validate that reviewed file through the existing offline production release check before any separately authorized deployment step. The tool does not install or activate the candidate, publish private artifacts, or create provider policy approval.

Unit tests use mocked API/RPC and hardware-verifier dependencies. They check enforcement and recovery behavior; they do not demonstrate a live NEAR hardware attestation, real USDC transfer, or production Arc anchor. Those conclusions require the actual independently verified evidence and canonical chain events from the authorized acceptance run.
