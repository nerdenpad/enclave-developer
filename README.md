# Enclave

The connected Enclave frontend and backend in one repository. The dashboard sends encrypted requests to the gateway, displays real model and policy data, requires explicit local payment confirmation, verifies signed receipts, and reads persistent history.

## Layout

| Directory | Contents |
| --- | --- |
| `frontend/` | TanStack/React dashboard, browser API client and browser tests |
| `_backend/` | Hono API, workers, PostgreSQL schema, Solidity contracts and provider integrations |
| `scripts/` | Combined local startup |
| `deliverables/` | Recorded walkthrough and verification notes |

The two applications retain their own npm lockfiles and dependency trees. There are no nested Git repositories and no root npm workspace dependency hoisting.

## Local deployment

Use Node.js 22.12+ or 24 LTS, npm, and a running local Docker engine.

```sh
npm run setup
npm run dev
```

Open **http://127.0.0.1:5173/dashboard/**. Enter `/api` for the gateway URL and use the private `DEMO_API_KEY` from `_backend/.env.demo` in the password field. The browser retains that credential only in memory.

The launcher prepares the isolated demo, starts the API on port 8789, registers its serving model, and starts the anchoring worker and frontend. PostgreSQL, Redis and Anvil use localhost ports 15433, 16379 and 18545. It rejects occupied application ports, validates existing database/chain identity and never automatically reseeds an existing demo. Startup does not send an inference request.

An initial clean checkout uses the local echo provider. To select NEAR before initial preparation, use an existing reviewed backend profile:

```sh
npm run demo:prepare -- --near-env /absolute/path/to/private/.env.near
npm run dev
```

See [_backend/docs/near-development.md](_backend/docs/near-development.md) for the Python verifier, provider credentials and reviewed attestation policy. NEAR inference uses paid provider credits. Keep the policy current; do not bypass failed evidence checks. `npm run dev` preserves an already configured provider.

This combined repository uses its own `enclave-full-demo` Docker project and volumes, separate from the former source folder's `enclave-demo` stack. Its profile and signer state live only in the ignored `_backend/.env.demo` and `_backend/data/demo/` paths. Both stacks use the same local ports, so stop the former demo before starting this one. Existing database/chain state must match its local manifest; the launcher refuses to adopt unrelated volumes or reset mismatched data.

Press Ctrl+C in the launcher terminal to stop the API, worker and frontend. Then stop only the demo containers, preserving state:

```sh
npm run demo:stop
```

## Verification

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
```

Browser tests use local API fixtures without provider charges. Install their browser with `cd frontend && npx playwright install chromium` if needed. Backend integration tests are available through `npm run test:integration` and use an isolated Docker test stack. GitHub Actions runs both applications from the repository root workflows.

After `npm run demo:prepare`, `npm run test:launch` starts the combined services, reads the authenticated workspace through the frontend proxy, and verifies graceful shutdown and closed application ports. Run it with the launcher stopped and Docker available. It sends no inference request and leaves the demo database containers running.

## Trust and deployment boundaries

NEAR can supply verified remote GPU inference. The gateway, its session keys and receipt signer remain in a software development environment. Local settlement uses test USDC on Anvil chain 31337. The dashboard does not submit real-network wallet authorizations or start autonomous agent jobs.

This local deployment does not publish a public website. Public hosting needs an HTTPS reverse proxy for `/api` and a server-side user authentication layer; the Vite proxy and operator API-key field are development facilities. The backend deliberately rejects production mode while gateway key custody remains in software.

Secrets, local `.env` profiles, CVM keys, virtual environments, dependency folders, recordings and generated runtime files are excluded from Git. Only configuration examples belong in a commit. This combined repository is independent of the original frontend's Lovable connection.

## Recorded walkthrough

[Enclave-Demo-2026-09-21.mp4](deliverables/Enclave-Demo-2026-09-21.mp4) shows the connected frontend and backend with a live NEAR request, signature verification, local-chain anchoring and persisted history. [Verification notes](deliverables/README.md) describe the environment and known limits. To make a new recording while the local services are running, use `npm run demo:record`; this performs a real provider workflow.
