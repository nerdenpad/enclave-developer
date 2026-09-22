# Local frontend integration

The demo runs the real API, PostgreSQL persistence, payment contracts, receipt queue and worker against local Anvil. Its default inference provider is **echo**. Echo returns a deterministic local response; it is not a hosted language model or a hardware TEE. The gateway always remains a development software CVM. Selecting `near-verified` verifies the remote provider's evidence and can incur real NEAR inference charges when a user submits a paid inference; it does not make the gateway a hardware enclave.

## Prepare the backend

Run all commands from `_backend`, with Node 22+, installed dependencies (`npm ci`) and a running local Docker engine. Reserve localhost ports 15433 (PostgreSQL), 16379 (Redis), 18545 (Anvil) and 8789 (API). Existing ordinary development ports and containers are left alone.

```sh
node --import tsx scripts/prepare-demo.ts
```

This starts only three containers in the `enclave-full-demo` Compose project. It creates ignored `.env.demo` and `data/demo/`, generates a new local admin API key, compiles contracts, migrates the fresh database, seeds it once, and deploys the local contracts. It explicitly directs deployment output to `.env.demo`, contract addresses to `data/demo/addresses.json`, and CVM keys to `data/demo/cvm.json`. The original `.env`, `data/cvm.json`, original database and the earlier separate repository's `enclave-demo` volumes are not reused.

The script captures child output because the existing seed command prints its API key. Neither provider credentials nor demo credentials are printed. Do not paste `.env.demo` into a browser, screenshot, issue or chat.

Open two terminals in `_backend`:

```sh
# Terminal 1: API
node --env-file=.env.demo --import tsx apps/api/src/index.ts
```

```sh
# Terminal 2: receipt anchoring, indexer and recovery worker
node --env-file=.env.demo --import tsx apps/worker/src/index.ts
```

Use clean terminals without conflicting application environment variables: Node's `--env-file` does not override values already exported in the shell. The bootstrap's own subprocesses explicitly isolate these values.

After the API is listening, run:

```sh
node --import tsx scripts/prepare-demo.ts --register
```

This uses the existing serving-model registration helper to read the active measurement, register the exact configured model and explicitly approve it on local chain 31337. It makes no inference request. The echo listing will normally already be approved; another model needs this step before inference. The one-hour production listing timelock is bypassed only through the explicit local bootstrap path enabled in `.env.demo`.

The API is at `http://127.0.0.1:8789`. `GET /health` is a public readiness/configuration read; it does not prove a successful inference or hardware attestation. The generated `DEMO_API_KEY` in `.env.demo` is a privileged local operator credential. The local browser dashboard accepts it in a password field and retains it only in memory. Production authentication should keep gateway credentials behind a trusted server boundary.

## Optional existing NEAR profile

Instead of the initial echo preparation, explicitly select an existing, reviewed profile:

```powershell
node --import tsx scripts/prepare-demo.ts --near-env "C:\Users\Administrator\Projects\enclave\.env.near"
```

Only inference-provider settings are copied into the ignored demo profile. Database URLs, chain URLs, wallet keys, API credentials belonging to the original gateway and CVM state paths are not imported. Relative `NEAR_VERIFIER_PYTHON` and `NEAR_ATTESTATION_POLICY` paths resolve against the selected profile's directory, so the existing Python environment and reviewed policy can remain in the original backend folder. The demo caps `NEAR_MAX_TOKENS` at 96 by default; its on-chain payment remains mock USDC.

The Python executable must already have the dependencies in `infra/near/requirements.txt`. Bootstrap does not install Python packages, fetch attestation evidence or make a paid provider call. Keep the reviewed policy current: the bundled September 19 policy expires on September 26, 2026 and must be reviewed again before replacement. A failed attestation stays a visible error; do not switch silently to echo or label an unverified result as verified.

To change the provider of an already prepared demo, stop API and worker, intentionally update only the provider settings in `.env.demo`, restart both, then run `--register`. Preparation refuses a second `--near-env` import to avoid silently changing existing runs. Preserve the serving image, TCB policy, CVM keys, deployment addresses and chain/database state.

## Frontend connection and request flow

Prefer a same-origin development proxy/BFF whose upstream is fixed to `http://127.0.0.1:8789`. Keep the gateway API key on that trusted server. Never put `INFERENCE_API_KEY`, `DEPLOYER_PRIVATE_KEY`, `.env.demo`, CVM secrets or the admin API key into `VITE_*`, `NEXT_PUBLIC_*`, frontend bundles or model prompts. A browser-only local developer client may accept a gateway API key from its operator, but that is a privileged local testing arrangement, not a production authentication design.

Authenticated routes use `x-api-key`. Each user operation needs its own stable `idempotency-key`. Keep the same key and identical encrypted request when retrying the same inference; generate a new key for a new prompt. A lost connection after a mutation is an unknown outcome, not permission to create another payment.

| Operation | API | Frontend behavior |
| --- | --- | --- |
| Workspace | `GET /v1/workspace` | Show the authenticated owner's persisted usage, payments, receipts and agents; use its pagination cursors. |
| Quote | `GET /v1/attestation/quote` | Read a development software quote; distinguish it from remote NEAR evidence. |
| Session | `POST /v1/session` with the quote body | Retain `sessionId`, `expiresAt`, and base64 `wrapKey` only in trusted session memory. |
| Inference challenge | `POST /v1/inference` | Send flat `{sessionId, iv, tag, ciphertext}` and an `idempotency-key` header. HTTP 402 contains the payment requirements in `details`. |
| Local settlement | `POST /v1/x402/settle` with `{paymentId}` | The demo uses mock USDC. Wait for the settlement result before submitting inference with that payment. |
| Paid inference | `POST /v1/inference` with the same encrypted fields plus `paymentId` | Decrypt `output`, retain `typedHash`, receipt and provider evidence; surface provider/attestation errors explicitly. |
| Payment recovery | `GET /v1/payments/:id` | Reconcile an uncertain settlement instead of starting another payment. |
| Receipt | `GET /v1/receipts/:typedHash` | Show pending/anchored state as returned; the worker anchors asynchronously. |
| Agent creation | `POST /v1/agents` | Creates a persisted agent identity and mandate; it does not automatically start an autonomous run. |
| Agent runtime | `/v1/agent-runs` | Disabled by default in this demo. Explicitly enable `AGENT_RUNTIME_ENABLED=true` only when autonomous bounded calls are intended. |

AES-GCM uses a 32-byte key, a fresh 12-byte IV and a 16-byte authentication tag. All three blob fields are base64. Web Crypto returns ciphertext with the authentication tag appended: split the last 16 bytes for `tag` when sending, and append the decoded tag to decoded ciphertext when decrypting. Keep the generated ciphertext unchanged across retries. Hash the decrypted output with SHA-256 and compare it to `outputHash`; receipt signatures and hardware evidence require their own independent verification. A displayed hash or successful AES decryption alone is not hardware verification.

The `/v1` payment flow above is the project's demo protocol. Standard external x402 clients use the separate `/v2/inference` route and the constraints documented in [x402-v2.md](x402-v2.md); do not label the `/v1` JSON flow as general x402 v2 interoperability.

## Connected dashboard

The sibling `frontend` directory contains the connected `/dashboard/` page, originally developed in `sleroy1312-arch/enclavelated`. Run `npm run dev` from the combined repository root to start the full demo, or start just the frontend with `npm ci` and `npm run dev -- --host 127.0.0.1 --port 5173` from its directory. Its Vite `/api` proxy points to this demo's port 8789. The production build needs its own reverse proxy and authentication; Vite does not deploy the local gateway.

`GET /v1/workspace` requires `x-api-key` and returns only that key owner's records, with `Cache-Control: no-store`. A repeatable-read snapshot contains aggregate `usage`, `receipts`, `payments`, `agents`, and independent pagination cursors under `page`. The default page size is 50 and the maximum is 100; use `limit`, `receiptsBefore`, `paymentsBefore` and `agentsBefore` to request older records. Cursors preserve timestamp precision and use the record ID to disambiguate ties. Agent rows include their current mandate, allowed models and today's spend; a missing mandate is represented as null rather than a zero allowance.

The response excludes prompt/output text, sealed agent memory, provider transcripts, payment authorization payloads and credential hashes. Aggregate usage covers the owner, while downloaded dashboard exports cover the currently loaded pages. Loading older pages pauses automatic refresh; explicit refresh returns to the newest page. Disconnecting clears private browser state. Uncertain paid inference can be explicitly retried with the same retained session, ciphertext, idempotency key and payment instead of creating another intent.

The September 21 integration check used live NEAR inference, browser AES-GCM and EIP-712 verification, actual local-chain settlement and worker anchoring, followed by a reload/reconnect to confirm durable history. The recorded walkthrough raises the local profile's `NEAR_MAX_TOKENS` to 512 to show more response text. The selected provider can return verbose text even when brevity is requested; the dashboard displays the actual signed output, which can end at the configured token limit. This does not change the default bootstrap limit or enable production mode.

## Reuse, stop and recovery

Re-running `prepare-demo.ts` checks the demo's database identity, saved chain checkpoint, deployed contracts and CVM key file. It recompiles artifacts but **does not reseed, redeploy or reset balances**. Incomplete initialization and mismatched state fail closed. The script never deletes or resets a database automatically.

Stop the API and worker with Ctrl+C first, allowing their shutdown to finish, then stop only this Compose project:

```sh
docker compose --env-file .env.demo -p enclave-full-demo -f docker-compose.demo.yml stop
```

PostgreSQL and Redis use named volumes. Anvil saves its state periodically and on graceful termination, with historical state enabled; see the [official Anvil state options](https://raw.githubusercontent.com/foundry-rs/foundry/master/crates/anvil/src/cmd.rs). These are local demo persistence aids, not a production backup system. If a crash leaves the chain and database inconsistent, restore their matching backup together with `.env.demo` and `data/demo/`; do not overwrite just the signer key or replay seed against the existing database.

For an intentionally fresh disposable demo, stop API/worker, back up the demo profile and state directory, then explicitly remove **only** the demo project and its volumes:

```sh
docker compose --env-file .env.demo -p enclave-full-demo -f docker-compose.demo.yml down --volumes
```

That command destroys the demo database, Redis queue and local chain. After deliberately discarding or moving aside the corresponding `.env.demo` and `data/demo/`, prepare again. Never apply this sequence to the original development project or original state directory. A partial bootstrap remains preserved for inspection until this explicit recovery choice is made.

Offline helper checks (no Docker and no provider calls):

```sh
npx vitest run scripts/prepare-demo.test.ts
```
