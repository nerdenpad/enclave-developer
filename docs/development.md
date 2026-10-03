# Development

Run commands from the repository root. See the [project overview](../README.md) for the hosted production deployment and current status.

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

See [_backend/docs/near-development.md](../_backend/docs/near-development.md) for the Python verifier, provider credentials and reviewed attestation policy. NEAR inference uses paid provider credits. Keep the policy current; do not bypass failed evidence checks. `npm run dev` preserves an already configured provider.

This combined repository uses its own `enclave-full-demo` Docker project and volumes, separate from the former source folder's `enclave-demo` stack. Its profile and signer state live only in the ignored `_backend/.env.demo` and `_backend/data/demo/` paths. Both stacks use the same local ports, so stop the former demo before starting this one. Existing database/chain state must match its local manifest; the launcher refuses to adopt unrelated volumes or reset mismatched data.

Press Ctrl+C in the launcher terminal to stop the API, worker and frontend. Then stop only the demo containers, preserving state:

```sh
npm run demo:stop
```

## Verification

Open `/verify` to verify an exported receipt without a workspace API key. Local verification stays in the browser; the optional RPC mode checks contract acceptance, model policy binding and a supplied anchor transaction. Open `/status` for public deployment settings and limits. See [E1 release acceptance](e1-release.md) for the remaining infrastructure and software work; E1 is not yet released.

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
npm run test:receipt-chain
```

Browser tests use local API fixtures without provider charges. Install their browser with `cd frontend && npx playwright install chromium` if needed. Backend integration tests are available through `npm run test:integration` and use an isolated Docker test stack. GitHub Actions runs both applications from the repository root workflows.

After `npm run demo:prepare`, `npm run test:launch` starts the combined services, reads the authenticated workspace through the frontend proxy, and verifies graceful shutdown and closed application ports. Run it with the launcher stopped and Docker available. It sends no inference request and leaves the demo database containers running.

## Trust and deployment boundaries

NEAR supplies verified remote GPU inference on the hosted deployment. Request encryption terminates at the application gateway. The local launcher uses test USDC on Anvil chain 31337. The hosted dashboard uses separately configured Arc Mainnet wallet authorization and settlement. Autonomous agent scheduling is opt-in.

The local launcher does not publish a public website. The hosted production deployment uses HTTPS, wallet sign-in, scoped sessions and owner-specific records. The Vite proxy and operator API-key field are development facilities. Production startup requires an exact reviewed release manifest, verified archived and fresh provider evidence, approved model policy and current contract bindings; see [NEAR + Arc release](near-arc-release.md).

Secrets, local `.env` profiles, runtime keys, virtual environments, dependency folders, new recordings and generated runtime files are excluded from Git. The reviewed walkthrough in `deliverables/` is tracked separately. Only configuration examples belong in a commit. This combined repository is independent of the original frontend's Lovable connection.
