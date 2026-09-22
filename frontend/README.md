# Enclave frontend

The dashboard connects to the Enclave gateway for encrypted inference, explicit payment approval, signed receipts, agent mandates and persisted usage. The original visual design is retained. Dashboard records come from the API; there is no simulated inference fallback.

## Run the integration locally

Use Node.js 22.12+ or 24 LTS and npm. `package-lock.json` is this application's dependency lockfile. The backend is included in the sibling `_backend` directory. From the combined repository root, `npm run setup` installs both applications and `npm run dev` starts the complete local demo. The steps below also allow running this frontend separately.

1. Prepare and start the API and worker using the backend's `docs/frontend-integration.md`. The isolated demo listens on `127.0.0.1:8789` and uses its own PostgreSQL, Redis and Anvil containers.
2. In this repository, run:

   ```sh
   npm ci
   npm run dev -- --host 127.0.0.1 --port 5173
   ```

3. Open `http://127.0.0.1:5173/dashboard/`. Leave the gateway URL as `/api`, enter the backend's `DEMO_API_KEY` in the password field, and connect. The key is held only in memory and must be entered again after a page reload.

The Vite development proxy sends `/api/*` to `http://127.0.0.1:8789`. Set `ENCLAVE_API_URL` in the process environment to use another development upstream. `.env.example` documents the value; copying it alone does not export it into the shell. Never put a provider key, wallet private key or gateway API key in a public build variable.

For deployment, configure a same-origin reverse proxy for `/api`, HTTPS, and a suitable server-side authentication layer. Vite's development proxy is not part of the production build. Direct browser entry of a privileged gateway key is a local operator workflow, not production user authentication.

## Available dashboard flows

- Read the active serving model, approved registry entries and policy.
- Create an agent mandate with a daily spend limit and use it for an inference request.
- Encrypt prompts and decrypt responses with browser Web Crypto (AES-256-GCM).
- Review the HTTP 402 challenge and explicitly settle local test USDC.
- Verify input/output hashes, EIP-712 receipt signatures and typed hashes in the browser.
- Read persisted receipts, payment state, settlement transactions and anchoring transactions.
- Export loaded audit metadata or usage CSV without prompt text, answers or credentials.
- Create a read-only key for all workspace receipt and payment metadata; current keys do not expire automatically.

The gateway selects the actual model; selecting an arbitrary model in the registry does not change its deployment. Agent mandates do not start autonomous jobs. External wallet authorization is not implemented in this dashboard, so authorized-payment mode does not offer automatic settlement.

NEAR provides remote verified GPU inference when the backend is configured for it. Provider usage is billed separately from local test USDC. The gateway, its session keys and receipt signer remain a software development environment. Receipt signature verification is distinct from GPU attestation; the browser relies on the gateway for the provider's hardware evidence checks.

## Checks

```sh
npm run typecheck
npm test
npm run test:e2e
npm run build
```

Browser tests use intercepted API fixtures and do not spend provider credits. Install Playwright Chromium with `npx playwright install chromium` if needed; `PLAYWRIGHT_CHROMIUM_EXECUTABLE` can point to an existing compatible executable.

## Record a live walkthrough

With the API, worker and frontend running, and the demo profile configured for `near-verified`:

```sh
node --env-file=../_backend/.env.demo scripts/record-demo.mjs --run-inference --record
node scripts/export-demo.mjs recordings/<timestamp> ../deliverables/Enclave-Demo.mp4
```

The first command runs one inference workflow and settles local test USDC. It records the actual browser, downloads audit metadata, verifies the flow, and writes a verification summary. Add `--show-recovery` to demonstrate up to two visible operator clicks on **Retry same request** if the request is interrupted; this preserves the payment, but can incur additional provider usage. Without this flag the recorder stops on an interrupted request. The second command adds English captions below the recorded interface and encodes an H.264 MP4 without narration. It refuses a failed browser run or an existing output filename. Recording files and local credentials are excluded from Git.

## Lovable

The frontend originated in the [Lovable project](https://lovable.dev/projects/dbfc7199-b561-4243-9d15-b23fad928535). This combined repository has no configured Lovable synchronization. Changes here do not update the original [hosted frontend](https://enclavelated.lovable.app). Published Git history should not be rewritten.
