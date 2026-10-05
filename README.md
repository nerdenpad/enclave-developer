# Enclave

Inference with signed receipts, attestation checks and on-chain verification.

A completed request carries a signed receipt. It binds the model, the code, the input,
the output and an attestation reference. You export it from the dashboard, check the
signature in the browser, and ask the configured contracts whether that receipt was
accepted and anchored.

NEAR is the selected GPU inference provider. The dashboard distinguishes local
test payments from Arc settlement. A receipt signature binds its fields; provider
verification and payment status are checked separately on the
[status page](https://enclaveagent.tech/status).

> ### Release status
>
> On **4 October 2026**, reviewed provider policy v6 passed a real **0.10 USDC**
> request, complete model answer, signed receipt and confirmed Arc anchor.
> The accepted release is installed; at 10:05 UTC the production API reported
> provider admission and backend readiness as ready. Every request still requires
> fresh verification. The approved price is **0.10 USDC per request**.
> On **5 October 2026**, the owner reported one successful paid wallet request
> with a correct answer and independent receipt and Arc-anchor checks. Fixes for
> old-session recovery, login messages and browser CI are implemented and passed
> local validation. A GitHub browser rerun and manual recovery checks remain
> pending; full E1 operational acceptance is still open.
> See [deployment status](https://enclaveagent.tech/status),
> [acceptance evidence](docs/release-progress.md) and
> [remaining E1 checks](docs/e1-release.md).

## Links

| | |
|---|---|
| Site | [enclaveagent.tech](https://enclaveagent.tech) |
| Milestones | [Roadmap](docs/roadmap.md) |
| Dashboard | [enclaveagent.tech/dashboard](https://enclaveagent.tech/dashboard) |
| Verify a receipt | [enclaveagent.tech/verify](https://enclaveagent.tech/verify) |
| Deployment status | [enclaveagent.tech/status](https://enclaveagent.tech/status) |
| X | [@enclave_arc](https://x.com/enclave_arc) |
| Telegram | [t.me/enclavearc](https://t.me/enclavearc) |

## What is in this repository

The frontend, backend and contracts share `main`.

| Directory | Contents |
|---|---|
| [frontend](frontend/) | React dashboard, receipt verifier and deployment status |
| [_backend](_backend/) | Hono API, workers, PostgreSQL, provider adapters and Solidity contracts |
| [infra/pilot](infra/pilot/) | Debian deployment, HTTPS and service configuration |
| [docs](docs/) | Architecture, development and release requirements |
| [deliverables](deliverables/) | Recorded local walkthrough and verification notes |

## Design decisions worth knowing

**Rejected evidence stops the request.** If remote CPU or GPU verification is unavailable
or the evidence is rejected, the gateway does not pick an unverified fallback. The
request ends.

**A signature is not a hardware proof.** A valid receipt shows that the configured signer
signed those hashes. It does not, by itself, prove the signer ran in a TEE, or that a
payment cleared. See [architecture and trust boundaries](docs/architecture.md).

**The status page reports the deployed path.** It labels the network, payment mode,
model and completed evidence separately so local test activity cannot be mistaken
for Arc settlement or a completed hosted inference.

## Development

Requires Node.js 22.12+ and a running Docker engine.

```sh
npm run setup
npm run dev
```

Open `http://127.0.0.1:5173/dashboard/`. Use `/api` as the gateway URL and the private
`DEMO_API_KEY` generated in `_backend/.env.demo`. The browser holds this key in memory.

A clean checkout starts with a local echo provider and test payments. Startup does not
make a paid inference request. See the [development guide](docs/development.md) for NEAR,
local services and integration checks.

Connect a wallet, then use **Sign in with connected wallet** to access its workspace.
Connection and login do not authorize a payment. See
[wallet setup and payment scope](docs/wallet-payments.md).

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
```

The [CI workflow](.github/workflows/ci.yml) covers both applications, provider checks,
contracts and browser flows. Browser tests use fixtures. Hardware and paid-provider
acceptance are separate checks in [E1 acceptance](docs/e1-release.md).
