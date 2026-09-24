# Wallet connections and real USDC

Planned scope, not an implemented feature. Enable after the operator's funding and domain migration milestone, with the settlement deployment accepted separately.

## User flow

1. Select **Connect wallet**, choose a wallet or scan a WalletConnect QR code on mobile.
2. Connect to the supported payment network. Display the account, network and USDC balance.
3. Before a paid request, show the exact USDC amount and recipient. Request a bounded payment authorization in the wallet.
4. Submit the authorization through the existing payment protocol, display settlement state, then show the inference result and receipt when successful.
5. If a request is interrupted or settlement is uncertain, recover the existing operation without requesting a second payment authorization or starting duplicate inference.

Connection alone does not authorize payment or authenticate a server-side user session. Account and network changes must invalidate any pending signing context.

## Wallet coverage

Use Reown AppKit with WalletConnect and browser wallet discovery. The chooser must offer at least 50 distinct wallets compatible with the selected EVM network, with search, QR connection and mobile links. Prioritize common wallets such as MetaMask, Trust Wallet, Rainbow, Rabby and OKX where compatible.

The wallet directory is not evidence that every listed wallet supports our payment signature. Before release, record the actual compatible wallet list and a connection/signature compatibility matrix. Count distinct wallets, not extension and mobile variants of one wallet. Test the main desktop and mobile journeys and publish any exceptions.

The current backend x402 v2 path supports EIP-3009 authorizations from externally owned accounts. ERC-1271 smart wallets and ERC-6492 counterfactual accounts are not currently supported. Reject unsupported account types before requesting payment; do not advertise them as payment-compatible until their backend path is implemented and verified. See [the payment protocol](../_backend/docs/x402-v2.md).

## Required deployment configuration

- Reown project ID, application metadata and the final domain allowlist.
- Selected EVM chain, RPC and confirmation policy; reviewed official USDC contract and its EIP-712 domain.
- Deployed Enclave contracts, recipient and funded relay wallet, with their addresses published in the deployment record.
- Server-side authentication and wallet ownership binding; an operator API key must not be shipped to public browsers.

## Acceptance

Verify successful payment, user rejection, insufficient funds, unsupported network/account, expired authorization, account changes, duplicate submission, timeout and restart recovery. Confirm the displayed amount and recipient match the signed authorization. Preserve the same request, nonce and payload across retries. If inference fails after settlement, show the payment transaction and failure state accurately; do not imply an automatic refund.

Test with a test token first, then perform an explicitly authorized small real-USDC acceptance transaction. A wallet modal or new domain alone does not enable production payments or complete E1.

References: [Reown React installation](https://docs.reown.com/appkit/react/core/installation), [wallet chooser options](https://docs.reown.com/appkit/react/core/options).
