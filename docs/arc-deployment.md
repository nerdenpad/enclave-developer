# Arc Mainnet deployment

Arc Mainnet is the selected USDC settlement network. The public pilot still uses private Anvil and MockUSDC. Selecting Arc in the browser does not migrate that backend or enable real payments.

See [payment launch preparation](payment-launch.md) for wallet roles, the starting reserve and read-only funding checks. Pricing approval is currently deferred.

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

## Before enabling settlement

1. Supply independently controlled deployment, governance and relay wallets, funded with Arc USDC for gas. Never reuse public Anvil private keys. Create a separate deployment record and payment state; do not reinterpret existing mock-chain records as mainnet payments.
2. Review RPC availability, gas estimation and finality handling against [Arc EVM differences](https://docs.arc.io/arc/references/evm-differences). Standard Anvil tests alone do not cover Arc-specific execution behavior.
3. Deploy and verify Enclave contracts, bind approved policies and signer, and record their addresses. Configure `ARC_CHAIN_ID=5042`, the reviewed RPC and token address, `USDC_EIP712_NAME=USDC` and `USDC_EIP712_VERSION=2`. The development default `USD Coin` is not the Arc signing name. This list is not a complete production environment.
4. Configure the scoped SIWE login and complete real-payment recovery acceptance. Browser receive authorization is implemented behind disabled release configuration; see [wallet payments](wallet-payments.md). Keep the current software-custody production guard enabled. Wallet login and EIP-3009 payments support EOAs; smart-contract wallets need separate support.
5. Validate exact token-emitter filtering and six-decimal amounts. Arc also emits native system transfer events; they must not be counted as a second payment. See [USDC system events](https://docs.arc.io/arc/references/usdc-system-events).
6. Test rejection, insufficient funds, nonce reuse, duplicate submissions, uncertain settlement and restart recovery. Complete an authorized small real-USDC payment before enabling the public payment action.

The hosted pilot now has a WalletConnect Project ID configured: the live check loaded 77 Arc-filtered catalog entries and confirmed a relay response and QR generation. Real-wallet approval and payment signatures still require acceptance; catalog membership alone does not demonstrate 50 compatible payment wallets. Keep the `enclaveagent.tech` domain allowlist configured. See [wallet acceptance](wallet-payments.md).
