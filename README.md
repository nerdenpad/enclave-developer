# Enclave

Inference with signed receipts, attestation checks and on-chain verification.

A completed request carries a signed receipt. It binds the model, the code, the input,
the output and an attestation reference. You export it from the dashboard, check the
signature in the browser, and ask the configured contracts whether that receipt was
accepted and anchored.

Underneath, the hosted gateway still runs on an ordinary VPS. NEAR is the selected
remote GPU provider, and gateway keys stay in software on that VPS. Payments on the
pilot are MockUSDC on a private Anvil chain, not USDC. **A valid signature says the
configured signer signed those hashes** — the [status page](https://enclaveagent.tech/status)
says what that does not prove.

> ### Production host
>
> On 26 September 2026 the customer accepted this software gateway as the production
> host and **cancelled the confidential-VM requirement**. Keys stay in software on the
> VPS. That decision does not settle USDC and does not complete a hosted inference.
>
> Hosted inference is waiting on NVIDIA. Their attestation service returns HTTP 403
> to the VPS, and strict verification stays on until that access is restored.
>
> Arc contracts are deployed and the hosted API settles on chain `5042` with a
> funded software relay. Public browser checkout stays off until a hosted inference
> request completes. See [payment launch](docs/payment-launch.md). What is live and
> what is still open is in the [roadmap](docs/roadmap.md).

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

**The status page does not invent a deployment.** Software key custody is named as
software. Settlement is named as MockUSDC on chain 31337. Where hosted inference has
not completed, that is what the deployment record says.

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

Connecting a wallet does not enable real-USDC payments and does not replace workspace
authentication. See [wallet setup and payment scope](docs/wallet-payments.md).

```sh
npm run typecheck
npm test
npm run test:browser
npm run build
```

The [CI workflow](.github/workflows/ci.yml) covers both applications, provider checks,
contracts and browser flows. Browser tests use fixtures. Hardware and paid-provider
acceptance are separate checks in [E1 acceptance](docs/e1-release.md).
