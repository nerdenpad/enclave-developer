# Development

Run commands from the repository root. See the [project overview](../README.md) for the hosted production deployment and current status.

## Local deployment

Use Node.js 22.12+ or 24 LTS, npm, and a running **local** Docker engine with Docker Compose v2. Start Docker Desktop or your local Docker service yourself and wait for `docker info` to succeed. The launcher checks Docker availability; it does not start or install Docker.

From a clean checkout, install both applications using the root setup command. `npm ci` at the root alone does not install their dependencies.

```sh
npm run setup
node scripts/enclave.mjs check
npm run dev
```

Open **http://127.0.0.1:5173/dashboard/**. Enter `/api` for the gateway URL and use the private `DEMO_API_KEY` from `_backend/.env.demo` in the password field. The browser retains that credential only in memory.

`check` reports missing Node, application dependencies, Docker CLI, Compose or the local Docker engine before starting services. It creates no demo state and makes no inference request. `node scripts/enclave.mjs --help` works before dependencies are installed. The launcher finds `_backend` and `frontend` relative to its own script, so an absolute script path also works from another directory.

`npm run dev` prepares the isolated demo, starts the API on port 8789, registers its serving model, and starts the anchoring worker and frontend. PostgreSQL, Redis and Anvil use localhost ports 15433, 16379 and 18545. The first preparation pulls the container images if needed, compiles local contracts, migrates and seeds the new demo database, and deploys its local contracts. It rejects occupied application ports, validates existing database/chain identity and never automatically reseeds an existing demo. Startup does not send an inference request.

An initial clean checkout uses the local echo provider. To select NEAR before initial preparation, use an existing reviewed backend profile:

```sh
npm run demo:prepare -- --near-env /absolute/path/to/private/.env.near
npm run dev
```

See [_backend/docs/near-development.md](../_backend/docs/near-development.md) for the Python verifier, provider credentials and reviewed attestation policy. NEAR inference uses paid provider credits. Keep the policy current; do not bypass failed evidence checks. `npm run dev` preserves an already configured provider.

Quote profile paths that contain spaces. A relative `--near-env` file path resolves from the directory where you invoke the launcher. Policy and Python paths inside that profile are then resolved relative to the profile's own directory. The profile must already exist; setup does not create provider credentials or install the Python verifier.

This combined repository uses its own `enclave-full-demo` Docker project and volumes, separate from the former source folder's `enclave-demo` stack. Its profile and signer state live only in the ignored `_backend/.env.demo` and `_backend/data/demo/` paths. Both stacks use the same local ports, so stop the former demo before starting this one. Existing database/chain state must match its local manifest; the launcher refuses to adopt unrelated volumes or reset mismatched data.

Press Ctrl+C in the launcher terminal to stop the API, worker and frontend. Then stop only the demo containers, preserving state:

```sh
npm run demo:stop
```

## Troubleshooting startup

| Diagnostic | Next step |
| --- | --- |
| Node.js is older than 22.12 | Install a supported Node version, reopen the terminal, confirm `node --version`, then run `npm run setup`. |
| Backend or frontend dependencies are missing | Run `npm run setup` from the combined repository root. An interrupted install can be rerun with the same command. |
| Docker CLI or Compose v2 is unavailable | Install Docker and its Compose plugin. Confirm `docker --version` and `docker compose version`. |
| Local Docker engine is unavailable | Start Docker manually and wait until `docker info` succeeds. Check your selected context with `docker context show`; this demo rejects remote Docker sockets. |
| Port 8789 or 5173 is already in use | Stop the other application instance. The launcher does not choose a different port or kill an unrelated process. The demo container ports also need to be free. |
| The selected NEAR profile does not exist | Pass an existing profile and quote its path if needed. Verify which directory the relative path starts from. |
| Demo initialization is incomplete or saved state does not match | Preserve `.env.demo`, `data/demo/` and the existing volumes. Follow the [explicit local recovery procedure](../_backend/docs/frontend-integration.md#reuse-stop-and-recovery); repeating setup does not repair or reset this state. |

For a frontend-only edit, run `npm --prefix frontend run dev` from the root. That starts the UI only; its `/api` proxy still needs a separately running demo gateway on port 8789.

The commands in [_backend/README.md](../_backend/README.md#run-locally), including `Copy-Item .env.example .env`, `db:migrate`, `contracts:deploy`, `worker` and the standalone backend `dev`, belong inside `_backend`. They use the separate ordinary backend stack on API port 8787. To follow that manual workflow, begin with `cd _backend`; use this guide's root commands for the combined demo on port 8789.

## Verification

Open `/verify` to verify an exported receipt without a workspace API key. Local verification stays in the browser; the optional RPC mode checks contract acceptance, model policy binding and a supplied anchor transaction. Open `/status` for public deployment settings and limits. See [E1 release acceptance](e1-release.md) for the remaining operational acceptance scenarios. The hosted service runs in production mode; this local launcher and its test funds do not establish public launch acceptance.

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
npm run test:receipt-chain
```

Browser tests use local API fixtures without provider charges. Install their browser with `cd frontend && npx playwright install chromium` if needed. Backend integration tests are available through `npm run test:integration` and use an isolated Docker test stack. GitHub Actions runs both applications from the repository root workflows.

Check launcher diagnostics and paths without Docker, service startup, provider calls or payment requests:

```sh
node --test tests/launch-preflight.test.mjs
```

After `npm run demo:prepare`, `npm run test:launch` starts the combined services, reads the authenticated workspace through the frontend proxy, and verifies graceful shutdown and closed application ports. Run it with the launcher stopped and Docker available. It sends no inference request and leaves the demo database containers running.

## Trust and deployment boundaries

NEAR supplies verified remote GPU inference on the hosted deployment. Request encryption terminates at the application gateway. The local launcher uses test USDC on Anvil chain 31337. The hosted dashboard uses separately configured Arc Mainnet wallet authorization and settlement. Autonomous agent scheduling is opt-in.

The local launcher does not publish a public website. The hosted production deployment uses HTTPS, wallet sign-in, scoped sessions and owner-specific records. The Vite proxy and operator API-key field are development facilities. Production startup requires an exact reviewed release manifest, verified archived and fresh provider evidence, approved model policy and current contract bindings; see [NEAR + Arc release](near-arc-release.md).

Secrets, local `.env` profiles, runtime keys, virtual environments, dependency folders, new recordings and generated runtime files are excluded from Git. The reviewed walkthrough in `deliverables/` is tracked separately. Only configuration examples belong in a commit. This combined repository is independent of the original frontend's Lovable connection.
