# ENCLAVE backend

ENCLAVE provides a Hono/tRPC gateway, PostgreSQL state, BullMQ workers and Solidity contracts for encrypted inference requests, signed receipts, USDC payments, sealed agents, model listings and token economics. The connected dashboard is included in the sibling `frontend` directory. See the [combined repository README](../README.md) for one-command startup or [local frontend integration](docs/frontend-integration.md) for detailed backend and browser setup.

The gateway uses a **software CVM** with local session-attestation fixtures. Inference supports synthetic/local backends, an authenticated Modal development endpoint, and a `near-verified` backend with actual Intel TDX and NVIDIA GPU evidence verification, attested TLS binding and provider signatures. NEAR verifies the remote model deployment; it does not isolate this gateway, its receipt signer or agent keys from the local host. The API rejects `NODE_ENV=production` until that boundary is moved into a hardware TEE. Real Arc confidential transfers remain unavailable.

## Layout

```text
apps/api        Hono + tRPC gateway, sessions, payments and administrative APIs
apps/worker     Receipt anchoring, chain indexing and background recovery
packages/core   Software attestation, receipts, AES-GCM, inference adapters and policies
packages/db     Drizzle/PostgreSQL schema, migrations and durable transaction signer
packages/agent-sdk  Claude Agent SDK MCP server and encrypted gateway tools
contracts       AttestationVerifier, ModelRegistry, UsageMeter, AgentMandate,
                ENCL, InsuranceStaking, FeeVault and local token/transfer fixtures
scripts         Local deployment, isolated integration runner and indexer recovery
infra/modal     Authenticated development vLLM GPU endpoint and offline Python tests
infra/near      Intel/NVIDIA verifier, reviewed development policies and crypto tests
```

## Run locally

Use Node.js 22 or newer, npm and a running Docker engine. Run commands from the repository root. The example below uses PowerShell; on a Unix shell use `cp .env.example .env` instead of `Copy-Item`.

```powershell
Copy-Item .env.example .env
npm ci
docker compose up -d postgres redis anvil
npm run db:migrate
npm run db:seed
npm run contracts:compile
npm run contracts:deploy
npm run dev
```

Run `npm run worker` in a second terminal and `npm run demo` in a third. The demo performs the 402 → settlement → inference → idempotent replay flow. The API listens on `127.0.0.1:8787`; local PostgreSQL uses port **5433**, Redis 6379 and Anvil 8545.

The seed creates the development admin key `enclave_dev_key`. Send it as `x-api-key: enclave_dev_key`. Existing API keys migrate with role `user`; reseeding a local database assigns the configured demo key the `admin` role.

Local deployment creates fresh contracts, wires the usage meter to the mandate and model registry, configures staking rewards, approves the echo model and writes contract addresses into `.env`. It uses the public Anvil development key and freely mintable MockUSDC. This script is a local deployment fixture, not a production deployment procedure.

### Local model inference

The default `INFERENCE_BACKEND=echo` produces deterministic synthetic bytes. To call a separately running local chat-completions server, set:

```dotenv
INFERENCE_BACKEND=openai-compatible
INFERENCE_BASE_URL=http://127.0.0.1:8000/v1
INFERENCE_MODEL=your-local-model-id
INFERENCE_TIMEOUT_MS=30000
```

The gateway sends non-streaming requests to `/chat/completions`, bounds response size and time, and returns encrypted output. Loopback endpoints work without a cloud account. Remote endpoints require `INFERENCE_ALLOW_REMOTE=true`, HTTPS and `INFERENCE_API_KEY`; redirects remain rejected. The timeout can be raised to 300000 ms. For a scale-to-zero endpoint, `INFERENCE_HEALTH_PATH=/health` enables authenticated readiness polling on the same origin before sending the prompt once; provider HTTP limits still apply.

Register and approve the corresponding model/code hashes before serving: the model hash is `sha256("model:" + INFERENCE_MODEL)`, and the code hash comes from the configured serving-image/TCB policy. The local deploy script initially registers only the echo model. A model ID and signed software receipt do not prove the model weights or hardware executing the request.

### Modal development GPU

See [the Modal setup guide](docs/modal-development.md) for CLI login, Secret creation, deployment and the real-inference check. `infra/modal/app.py` deploys one scale-to-zero L4 with pinned public Qwen weights, a Bearer-protected vLLM API and disabled prompt/response logging. This is ordinary GPU inference. NEAR is the current GPU TEE provider, using the verified integration described below.

`python scripts/modal-secret.py init` creates an ignored `.env.modal` overlay and a random inference key without printing it. After Modal login, `python scripts/modal-secret.py upload` creates the named `enclave-inference` Secret without replacing an existing Secret. It sends only `INFERENCE_API_KEY`, never the database settings or blockchain wallet. Use the Python in `infra/modal/.venv` for commands that import Modal.

After setting the deployed HTTPS URL plus `/v1` in `.env.modal`, `npm run inference:check` performs one small paid inference. `npm run dev:modal` starts the gateway with that overlay and the regular `.env` database/chain settings. `npm run test:modal` runs offline configuration, authentication and Secret-helper tests and creates no cloud resources.

### Verified NEAR GPU development

See [the NEAR setup and trust boundaries](docs/near-development.md). The `near-verified` adapter obtains fresh CPU/GPU evidence before sending each prompt, verifies vendor signatures and an explicit expiring measurement policy, binds HTTPS to the attested TLS key, and verifies the exact request/response signature. An unapproved VM, stale TCB, invalid signature or transport change fails closed. The reviewed development policies explicitly retain trust in NEAR's privileged deployment manager; they are not immutable-workload or model-weight proofs.

Responses additionally contain `providerEvidence`: an EIP-712 sidecar associates the NEAR signature and hashes with the local receipt; the full request/response and hardware evidence transcript is encrypted with the session key. The original receipt `attRef` continues to identify the local session quote. Public receipt views expose neither transcript nor output. Completed idempotent retries return the same persisted proof and ciphertext without a second provider request.

### Claude Agent SDK

[`@enclave/agent-sdk`](packages/agent-sdk/README.md) provides an actual in-process Claude Agent SDK MCP server with quote, session, encrypted inference and settlement tools. The gateway API key stays in the host process; the session wrapping key is delivered only to a trusted host callback and never enters model context. The host prepares ciphertext and supplies externally signed payment authorizations. The package includes a lazy query example and tests through the real MCP client/server transport without model calls.

### Durable agent jobs

The opt-in [agent runtime](docs/agent-runtime.md) executes bounded reasoning steps through the gateway. Goals, credentials and state are encrypted; PostgreSQL leases coordinate runners, and an authenticated action journal links each step to its receipt and payment. Authorized mode waits for an external payment signature. Uncertain external outcomes require reconciliation before another step. `AGENT_RUNTIME_ENABLED=false` is the default. This is a software-host runtime with no arbitrary shell or browser tools and no hardware-held wallet.

Tool registration does not create a sealed autonomous runtime or wallet. Receipt and hardware proof verification remain independent of the adapter's response-format validation.

## Request and receipt flow

1. Fetch `GET /v1/attestation/quote`, then submit the quote to `POST /v1/session` with an API key. The software CVM validates the configured vendor signature, image measurement and CPU/GPU policy flags before releasing its software-held key. The response contains a session ID and base64 `wrapKey`.
2. Encrypt the request using the session key and AES-GCM. `POST /v1/inference` accepts `sessionId`, `iv`, `tag`, `ciphertext` and an optional `agentId`. Without payment it returns HTTP 402 with `details.accepts[0].extra.paymentId`.
3. Settle the payment, then repeat the same request with `x-payment: <paymentId>` or the `paymentId` body field. Use an `Idempotency-Key` to recover the same completed response.
4. The response contains a signed receipt, its EIP-712 typed hash, an output hash and an AES-GCM `output` blob. Decrypt output with the session key and verify its hash against the receipt.

Payment intents bind the API-key owner, request, agent and model listing. A payment cannot be consumed for a different request. Idempotency keys are scoped to the caller and request; concurrent reuse is serialized in PostgreSQL. Agent memory is stored and returned as sealed ciphertext. Public receipt endpoints expose the hash projection; auditor fields require a valid view-key. Prompt/output plaintext and key material are redacted from application logs.

New receipts use **EIP-712 version 2** with a random `bytes32 nonce`, so identical calls in the same second have distinct hashes. The receipt's `attRef` identifies the caller's verified session quote. The database persists receipt version, nonce, chain ID, verifier address, signature and encrypted output. The worker checks the persisted domain before anchoring. Existing version-1 receipts have an explicit legacy verification path; new inference does not generate version 1. Sessions retain their signed quote so the software CVM can revalidate admission after a process restart.

The attestation and model keys live in an ordinary process and local persistence in this implementation. AES-GCM protects transport/storage blobs but does not isolate plaintext from the host administrator or local inference process.

## USDC payments and agent mandates

`PAYMENT_MODE=mock` mints local MockUSDC for the shared development signer. `PAYMENT_MODE=authorized` instead debits an externally funded payer using EIP-3009 `ReceiveWithAuthorization`; the gateway does not mint or subsidize that payment.

For authorized payments:

1. Obtain the payment ID from the inference challenge.
2. Call `GET /v1/payments/:id/authorization?from=0x...` with the payment owner's API key.
3. Sign the returned typed data with the payer wallet.
4. Submit `POST /v1/x402/settle` with `paymentId` and `authorization: { from, validAfter, validBefore, signature }`. Time fields are decimal strings; the signature is a 65-byte canonical signature with `v=27/28`.
5. Retry inference using that payment ID.

The signature binds the token's EIP-712 domain, payer, UsageMeter recipient, amount, validity window and a nonce derived as `keccak256(UTF8(paymentId))`. Configure `USDC_EIP712_NAME` and `USDC_EIP712_VERSION` for the actual token; defaults match the local fixture. A real token deployment, domain and authorization ABI must be verified separately.

UsageMeter performs token movement, approved-model provider fees and agent mandate spending in the **same EVM transaction**. Mandate commitments bind payer, agent, amount and payment ID; failures roll back the entire transfer. There is no separate API-side on-chain spend before settlement. PostgreSQL also reserves the caller's daily limit while settlement is in progress.

For an external payer's agent, that payer must first call `AgentMandate.open(keccak256(UTF8(agentId)), dailyLimitInUsdcUnits)` from its own wallet. The on-chain mandate owner must equal the authorized payer. The gateway cannot open an external wallet's mandate on its behalf. The local mock path can open mandates for its own shared signer.

**Trusted routing:** EIP-3009 signs a token transfer, not the listing/agent routing fields. `settleAuthorized` therefore accepts calls only from the meter owner relay or the payer. The gateway binds routing to the stored payment intent; the owner relay remains trusted for that routing. This is not a permissionless routing authorization protocol.

The `/v1` flow remains the original project-specific challenge/settlement protocol. `/v2/inference` additionally supports standard **x402 v2 exact EVM EIP-3009** headers and has interoperability tests using the official `@x402/core` and `@x402/evm` clients. It requires authorized payment mode and the matching version-2 UsageMeter deployment. See [the v2 protocol, client example and recovery boundaries](docs/x402-v2.md). Supported payers are EOAs; Permit2, smart-account signatures, arbitrary external facilitators and Circle Nanopayments are not included.

### Durable settlement and recovery

Shared-wallet API and worker writes use a PostgreSQL transaction journal. A signer advisory lock coordinates nonce allocation across processes sharing the database. Signed raw transaction bytes, operation parameters and the transaction hash are committed **before broadcast**. Retrying an operation reuses the committed transaction; changed parameters under the same operation key are rejected.

Confirmation requires the exact recorded hash, a canonical block hash, successful execution and the configured depth. Payment consumption additionally verifies the expected UsageMeter settlement event, payer, amount and payment ID. Previously confirmed journal entries are checked against current canonical block hashes before assigning a higher nonce. Orphaned transactions can be rebroadcast from their committed bytes. If a nonce was consumed by another transaction, signing halts with `SignerNonceConflictError` for operator review instead of silently advancing.

The API reconciles payments at startup and every **15 seconds**. Stale settlement claims become `settlement_unknown`; only durable, versioned settlement intents are resumed automatically. Recovery preserves the original authorization, deployment and payment mode. Legacy uncertain rows without this intent metadata, including old rows lacking a settlement start time, remain quarantined for explicit review. Unknown RPC outcomes never reopen a payment for another charge; a proven mined revert is distinguished from an unknown outcome.

The worker also recovers journaled transactions and scans persisted pending/anchoring receipts to repair the database-to-Redis enqueue gap. Job recovery preserves retry budgets. PostgreSQL and the chain are not one atomic transaction: the journal, replay protection and proof checks implement recovery across that boundary.

The signer currently scans its complete per-signer history when reconciling or allocating a nonce. Its database/RPC work grows as **O(history)**; journal compaction/checkpointing and load testing are still required for sustained production throughput. Administrative requests do not expose a general client idempotency protocol for every operation.

## Model registry and economics

Listings lock the configured ENCL deposit. The regular approval route enforces the contract's **one-hour timelock**, reports `409 TIMELOCK_ACTIVE` before the deadline, and exposes `availableAt` and chain time through the approval-status route. Revoked or unapproved models cannot serve inference.

Immediate bootstrap approval/restoration exists only for chain ID **31337**. The API additionally requires `ALLOW_LOCAL_BOOTSTRAP=true`, which defaults to false. The dedicated `/bootstrap-approve` route makes this local bypass explicit. Production approval uses the timed route; local restoration is not evidence of production deposit enforcement.

Software TCB changes use separate proposal and activation operations. A policy-aware listing commits the immutable policy hash/version alongside the model/code pair; activation checks that exact approved binding and the chain deployment scope. Existing legacy listings cannot be upgraded in place. Active state is persisted across gateway restarts; activation retires old sessions and blocks publication by in-flight requests using the previous policy. The explicit local fixture bypass is labelled as such and does not prove chain deployment identity or hardware approval. Neither software policy rotation nor the registry binding changes the independently reviewed NEAR hardware allowlist. See the [operator workflow and migration limits](docs/tcb-policy-lifecycle.md).

An approved listing's `listingBps` is the provider's share of the **gross payment**, paid directly by UsageMeter. `providerEarned` and `listingVolume` record realized per-listing amounts. The remainder enters FeeVault. These provider payments are separate from FeeVault's configured provider-pool allocation.

FeeVault distributes available, unreserved funds in the base **80/10/5/5** treasury/stakers/providers/ecosystem split. Integer rounding remainder goes to ecosystem. Staking receives USDC rewards proportional to ENCL stake, measured from actual received token balances. Stake and unstake checkpoint rewards first, so a new depositor cannot take rewards already received for earlier stakes. Rewards received when no one is staked are quarantined as `unallocatedRewards`; only the owner can recover them. Undistributed FeeVault funds are not yet staking rewards. Withdrawal preserves accrued rewards, and claims transfer actual USDC.

Buybacks are implemented through an owner-configured `IBuybackRouter.swapExactInput` adapter:

- `treasuryBps` reserves 0–1000 basis points of the treasury share; the default is **0**.
- At 1000, net vault distribution is **72/10/5/5**, with **8%** retained in `reservedBuyback`, subject to integer rounding.
- Execution spends only that reserve, requires positive `amountUnits` and `minOut`, checks `deadline`, measures actual input/output balances and clears the router allowance.
- The administrator must supply a deployed router adapter, output token, recipient and minimum output. No live DEX address, automatic quote source or trading schedule is configured.
- Legacy `queueBuyback` remains an event-only compatibility method. The API's reserve and execute routes use the funded implementation.

Staking, unstaking, reward claims, listing changes, fee distribution, buyback configuration/execution and TCB rotation require an admin API key because they act through the shared operator wallet. These APIs do not provide customer-owned staking wallets or production admin-key provisioning. Staking custody and rewards are implemented; an insurance loss waterfall, claims adjudication and slashing are not.

## Chain indexing and finality

Indexer state is scoped by chain ID, genesis hash, deployment identity and configured contract addresses. Set a stable `CHAIN_DEPLOYMENT_ID` when distinct deployments share a database. The worker validates RPC chain identity, filters canonical logs, commits event batches with their cursor, and derives model approval/revocation policy from registry events.

`CHAIN_CONFIRMATIONS` controls the number of blocks required after inclusion. Defaults are zero on local chains and twelve elsewhere. Confirmation is a configured risk threshold, not a promise of irreversible finality.

The indexer retains a bounded header history (128 blocks by default). On a shallow reorg it quarantines affected serving policy, removes orphaned scoped events, rewinds to a common ancestor and replays canonical events. A deeper fork enters `INDEXER_REBUILD_REQUIRED` and fails closed. After investigating, stop the worker and reset only the selected scope using the current environment:

```sh
npm run indexer:reset
npm run worker
```

This clears that scope's indexer event/cursor state and replays from genesis; model serving remains quarantined until rebuilding finishes. It does not erase payments or reset the signer journal. Nonce conflicts require separate investigation of the recorded signed transaction and canonical chain.

## HTTP API

Authenticated routes use `x-api-key`; auditor export uses `x-view-key`. Administrative checks apply to shared-wallet mutations as described above.

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/health` | Liveness, software TEE mode and chain ID |
| GET | `/v1/attestation/quote` | Software vendor-signed quote |
| POST | `/v1/session` | Verify quote and create a session/wrapping key |
| POST | `/v1/inference` | Encrypted request; 402 challenge or receipt plus encrypted output |
| POST | `/v2/inference` | x402 v2 `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, authorized EOA payer |
| GET | `/v1/payments/:id/authorization?from=...` | Payer EIP-3009 typed data for an owned payment |
| POST | `/v1/x402/settle` | Mock or signed-payer settlement |
| GET | `/v1/payments/:id` | Public status; valid view-key unlocks auditor fields |
| GET | `/v1/receipts/:typedHash` | Public receipt projection; view-key unlocks auditor fields |
| GET | `/v1/agent-sdk/tools` | Agent tool manifest |
| POST | `/v1/agent-sdk/invoke` | Quote/session/infer/settle adapter |
| GET/POST | `/v1/agents` | List or create sealed agents and policy |
| GET | `/v1/agents/:id` | Owned agent record with sealed memory |
| POST | `/v1/agents/:id/memory` | Re-seal memory supplied as a session ciphertext |
| GET/POST | `/v1/agent-runs` | List or create owned, bounded agent jobs |
| GET | `/v1/agent-runs/:id` | Job status and action journal; optional encrypted result export |
| POST | `/v1/agent-runs/:id/cancel` | Request cancellation without replaying a dispatched call |
| POST | `/v1/agent-runs/:id/resume` | Supply payment authorization or reconcile a persisted outcome |
| GET/POST | `/v1/stake` | Operator stake status / stake ENCL |
| POST | `/v1/unstake` | Withdraw operator ENCL stake |
| GET | `/v1/stake/rewards` | Operator's pending USDC rewards |
| POST | `/v1/stake/rewards/claim` | Claim operator's rewards |
| GET | `/v1/fees/split` | Base 80/10/5/5 preview before optional reserve |
| POST | `/v1/fees/distribute` | Execute distribution and report actual net amounts/reserve |
| GET | `/v1/buyback` | Recorded reserve/execution history |
| GET | `/v1/buyback/status` | Reserve, rate, router, token, recipient and distributable balance |
| POST | `/v1/buyback/configure` | Set `router`, `tokenOut` and `recipient` |
| POST | `/v1/buyback/reserve` | Set `treasuryBps` |
| POST | `/v1/buyback/execute` | Swap reserve with decimal-string `amountUnits`, `minOut`, `deadline` |
| GET | `/v1/models` | Approved model catalog |
| GET | `/v1/marketplace` | Marketplace records |
| POST | `/v1/marketplace/list` | Create a staked listing |
| GET | `/v1/marketplace/:id/approval` | State and timelock deadline |
| POST | `/v1/marketplace/:id/approve` | Timed approval |
| POST | `/v1/marketplace/:id/bootstrap-approve` | Explicitly enabled local-only approval |
| POST | `/v1/marketplace/:id/revoke` | Revoke listing |
| GET | `/v1/tcb/policies` | Active software policy and history |
| POST | `/v1/tcb/rotate` | Propose an immutable pending software policy |
| POST | `/v1/tcb/:version/activate` | Activate an admitted policy with expected active version |
| GET | `/v1/solvency/:asset` | Software CVM status |
| GET | `/v1/chain/events` | Stored indexed contract events |
| POST | `/v1/compliance/view-keys` | Issue an auditor secret once |
| GET | `/v1/compliance/export` | Auditor export authenticated by view-key |
| * | `/trpc/*` | Quote, solvency, catalog, agent, stake and TCB read procedures |

## Automated verification

```sh
npm ci
npm run typecheck
npm test                              # Core, API, worker and Claude SDK unit suites
npm run test:integration              # Disposable PostgreSQL, Redis and Anvil
npm run test:contracts                # Isolated Forge tests, native or Docker
npm run test:coverage                 # V8 reports, including integration coverage
npm run test:contracts -- --coverage  # Solidity source LCOV
npm run test:all                      # Typecheck, units, integration and contracts
```

`npm test` compiles Solidity artifacts first; it does not require services. Integration tests allocate loopback ports and a unique Compose project, deploy fresh contracts, apply migrations twice and exercise actual database races, queue/chain round trips, settlement recovery, external-payer authorization, economic transfers and reorgs. They use scratch keys/deployment files under ignored `work/` and remove only their own containers/volumes. The normal `.env`, keys, development database and chain are not modified.

Unit suites cover cryptography/receipt domains, session ownership, request validation, authorization, idempotency, inference bounds, economic events and recovery failure paths. Solidity tests include access control, signature malleability, replay, atomic rollback, mandate limits, timelocks, provider fees, reward allocation and measured buyback execution. See [contracts/TESTING.md](contracts/TESTING.md) for contract scenarios and source coverage details.

V8 reports are written to workspace `coverage/` directories. The contract launcher uses native Forge when available or Foundry Docker otherwise, with Solidity 0.8.28; a first run may download the compiler. Forge executes an isolated EVM and does not connect to development services. Test-only cheatcodes are vendored as a minimal harness; independent deployment `.s.sol` scripts requiring `forge-std` are excluded from test compilation. GitHub Actions runs the verification commands.

The Python verifier and Modal helper suites run separately with `npm run test:near` (after installing `infra/near/requirements.txt`) and `npm run test:modal`. CI includes both. The dated [implementation and verification report](docs/backend-status-2026-09-19.md) records measured coverage, the real NEAR acceptance run and remaining requirements.

## Remaining integration limits

- Intel TDX/NVIDIA cryptographic verification and TLS-bound remote NEAR inference are implemented. NEAR is the selected GPU inference provider. Hardware isolation of Enclave's own gateway and agent runtime, immutable measured workload/weights, hardware-only key release, and the PDF's comparable hardware overhead benchmark remain separate requirements. These requirements do not mandate a switch to Phala. See the NEAR guide for the current integration's explicit trust limits.
- `confidential=true` is supported only in local mock payment mode. MockConfidentialTransfer exercises a hook without moving USDC or proving a shielded amount; it cannot support confidential agent mandates. Nonlocal/authorized confidential requests fail closed. There is no implemented Arc shielded-transfer privacy or explorer/view-key integration.
- Authorized public payments and router buybacks have real contract paths and local tests, but live USDC/Arc/DEX deployment configuration and interoperability remain external integration work.
- On-chain receipts attest the configured signer's assertion and approved model/code pair. The full hardware quote and TCB/vendor policy are not independently verified by the Solidity registry.
- Durable agent jobs provide bounded reasoning, encrypted state and recovery. They do not implement arbitrary external tools, a separately isolated agent wallet or a collateralized credit lane; authorized payments use an external payer and its on-chain mandate.
- Public chain payments expose public token transfers. Application auditor view-keys restrict API exports; they do not hide public blockchain data.
- The current software stack, local admin provisioning, full-history journal scans and in-process inference/database transaction duration have not been qualified for production throughput or availability.
