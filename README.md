# Enclave

Inference with signed receipts, attestation checks and on-chain verification.

[Website](https://enclaveagent.tech) · [Dashboard](https://enclaveagent.tech/dashboard) · [Verify a receipt](https://enclaveagent.tech/verify) · [Deployment status](https://enclaveagent.tech/status) · [Roadmap](docs/roadmap.md)

Enclave connects a model request to a signed record of its model, code, input, output and attestation reference. The dashboard handles encrypted requests, payment confirmation and receipt history. A separate verification page checks exported receipts without a workspace account.

## Current deployment

**Software pilot. E1 is not released.** The website and API run on a standard VPS. NEAR is the selected remote GPU provider; gateway keys and the receipt signer remain in software on the VPS. Payments use MockUSDC on a private Anvil chain, not real USDC.

As of 24 September 2026, the public pages, authenticated workspace and HTTPS checks pass. Hosted inference is blocked: NVIDIA's attestation service returns HTTP 403 to the VPS. Verification remains enforced. The earlier [local demonstration](deliverables/README.md) includes a successful NEAR request; it is not evidence of successful inference on the hosted deployment.

## How it works

1. The browser encrypts a prompt for the gateway and asks the user to confirm the development payment.
2. The gateway checks the request and payment state. With the NEAR integration selected, it verifies remote CPU/GPU evidence and the provider connection before sending the prompt.
3. A successful request returns encrypted output and a signed inference receipt. A worker anchors the receipt through the configured contracts.
4. The user can export the receipt and check its signature in the browser. Optional RPC checks evaluate contract acceptance, model policy and a supplied anchor transaction.

The software gateway can access the prompt and its signing keys. Remote GPU attestation does not make this VPS confidential. Receipt signature verification also does not independently verify hardware evidence or prove payment. See [architecture and trust boundaries](docs/architecture.md).

## Repository

The frontend, backend and contracts share `main`.

| Directory | Contents |
| --- | --- |
| [frontend](frontend/) | React dashboard, receipt verifier and deployment status page |
| [_backend](_backend/) | Hono API, workers, PostgreSQL, provider adapters and Solidity contracts |
| [infra/pilot](infra/pilot/) | Debian deployment, HTTPS and service configuration |
| [docs](docs/) | Architecture, development and release requirements |
| [deliverables](deliverables/) | Recorded local walkthrough and verification notes |

## Run locally

Requires Node.js 22.12+ and a running Docker engine.

```sh
npm run setup
npm run dev
```

Open `http://127.0.0.1:5173/dashboard/`. Use `/api` as the gateway URL and the private `DEMO_API_KEY` generated in `_backend/.env.demo`. The browser holds this key in memory.

A clean checkout starts with a local echo provider and test payments. Startup does not make a paid inference request. See the [development guide](docs/development.md) to configure NEAR, manage local services and run integration checks.

The dashboard also supports browser wallet connections. Direct WalletConnect pairing and its searchable directory require a public Project ID configured before building. Connecting a wallet does not enable real-USDC payments or replace workspace authentication. See [wallet setup and payment scope](docs/wallet-payments.md).

## Verification

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
```

The [CI workflow](.github/workflows/ci.yml) covers both applications, provider checks, contracts and browser flows. Browser tests use fixtures; hardware and paid-provider acceptance are separate checks. [E1 acceptance](docs/e1-release.md) lists the evidence required for release.

## Documentation

- [Architecture and trust boundaries](docs/architecture.md)
- [Development and tests](docs/development.md)
- [NEAR integration](_backend/docs/near-development.md)
- [Single-server deployment](infra/pilot/README.md)
- [Roadmap](docs/roadmap.md) and [E1 acceptance](docs/e1-release.md)
- [Recorded demonstration](deliverables/README.md)
