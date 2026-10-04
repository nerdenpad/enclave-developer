# Arc Mainnet deployment

Arc Mainnet is the selected USDC settlement network. Contracts were deployed on 26 September 2026 against the reviewed USDC token. The hosted API and worker use chain `5042` with `PAYMENT_MODE=authorized` and a dedicated relay. Reviewed provider policy v6 passed a fresh paid acceptance on 4 October 2026 and is installed with its accepted release manifest; public backend and provider readiness were true at 10:05 UTC. Public browser checkout is configured at the approved **0.10 USDC per request**. Serving policy version 2 is registered, approved and active.

See [payment operations](payment-launch.md) for wallet roles and [release progress](release-progress.md) for confirmed settlement and receipt transactions. Web QA fixes were deployed on 3 October 2026. Manual wallet acceptance is reopened after an OKX regression report; a real retest is still pending, while the earlier 3 October owner confirmation remains in the acceptance history.

## Reviewed public parameters

| Parameter | Value |
| --- | --- |
| Chain ID | `5042` (`0x13b2`) |
| RPC | `https://rpc.mainnet.arc.io` |
| Explorer | `https://explorer.arc.io` |
| Native gas currency | USDC, 18 decimals |
| ERC-20 USDC | `0x3600000000000000000000000000000000000000`, 6 decimals |
| USDC EIP-712 name / version | `USDC` / `2` |
| USDC domain separator | `0x940506929bba468048a19b567f4f0d534714bc06604b5c3017e5d16785ccdf84` |

Network details come from [Arc](https://docs.arc.io/arc/references/connect-to-arc); the token address is listed by [Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses). The native and ERC-20 interfaces represent the same USDC balance. Use six-decimal integer units for ERC-20 payment authorizations and 18-decimal units for native gas. Do not add those balances together.

The shared public profile is `frontend/src/enclave/arc-mainnet.json`. From the repository root, after installing frontend dependencies:

```sh
npm run check:arc
```

This read-only check verifies chain ID, token name/version/decimals, the on-chain domain separator against a locally computed EIP-712 hash, EIP-3009 authorization-state access and block consistency. It loads no private key and submits no transaction. It passed on 24 September 2026 at block `22559511`. This is evidence for configuration, not payment acceptance or full write-method compatibility.

## Deployment and acceptance checklist

The deployed payment path passed four real paid requests totalling 0.40 USDC, including a WalletConnect operator browser journey and complete final model answers. The fourth passed under reviewed provider policy v6 on 4 October 2026. The checklist below also applies to a replacement deployment. A real manual OKX retest, live settlement interruption, signer rotation and model revocation remain in the [E1 acceptance matrix](e1-release.md).

1. Supply independently controlled deployment, governance and relay wallets, funded with Arc USDC for gas. Never reuse public Anvil private keys. Create a separate deployment record and payment state; do not reinterpret existing mock-chain records as mainnet payments.
2. Review RPC availability, gas estimation and finality handling against [Arc EVM differences](https://docs.arc.io/arc/references/evm-differences). Standard Anvil tests alone do not cover Arc-specific execution behavior.
3. Deploy and verify Enclave contracts, bind approved policies and signer, and record their addresses. Configure `ARC_CHAIN_ID=5042`, the reviewed RPC and token address, `USDC_EIP712_NAME=USDC` and `USDC_EIP712_VERSION=2`. The development default `USD Coin` is not the Arc signing name. This list is not a complete production environment.
4. Configure scoped SIWE login and reviewed browser receive authorization; see [wallet payments](wallet-payments.md). Public checkout is configured on the installed deployment; current provider checks govern admission. Retain the production release checks when replacing it. Wallet login and EIP-3009 payments support EOAs; smart-contract wallets need separate support.
5. Validate exact token-emitter filtering and six-decimal amounts. Arc also emits native system transfer events; they must not be counted as a second payment. See [USDC system events](https://docs.arc.io/arc/references/usdc-system-events).
6. Test rejection, insufficient funds, nonce reuse, duplicate submissions, uncertain settlement and restart recovery. Complete an authorized small real-USDC payment before enabling the public payment action.

WalletConnect is configured for `enclaveagent.tech`. The recorded browser check loaded 77 Arc-filtered catalog entries; the subsequent real operator protocol journey completed sign-in, payment, inference and receipt verification. Manual wallet acceptance is reopened following the detailed OKX failure report and awaits retest; the earlier owner confirmation on 3 October 2026 is retained in [release progress](release-progress.md#manual-wallet-regression--3-october-2026). Catalog membership does not establish payment compatibility for every listed wallet. Keep the domain allowlist configured and retain wallet-specific acceptance records. See [wallet acceptance](wallet-payments.md).
