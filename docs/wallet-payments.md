# Wallet connections and real USDC

The final domain is **enclaveagent.tech**. The selected payment network is **Arc Mainnet (5042)**. Wallet connection is implemented separately from payments. Real-USDC settlement still requires contract deployment, funded operator wallets and payment acceptance. See the [Arc deployment profile](arc-deployment.md).

## Implemented connection

The dashboard uses the direct WalletConnect Sign Client, with an Enclave-owned dialog and QR renderer. Reown AppKit is not installed. Browser extensions are discovered through EIP-6963, with a legacy provider fallback. Connection only reads accounts and chain ID; it does not request a payment signature, send a transaction or authenticate a gateway user.

Account and network changes update the browser-wallet display. A WalletConnect approval change invalidates the session and requires reconnection. Cancellation ignores late approvals and closes any late remote session. The dialog supports keyboard navigation, Escape and focus restoration.

Browser extensions work without a Project ID. Remote pairing and the catalog use the public `VITE_WALLETCONNECT_PROJECT_ID` in `frontend/.env.local` at build time. Configure the project and domain allowlist through WalletConnect/Reown; see [the Explorer API requirements](https://docs.reown.com/cloud/explorer). The supplied project is configured on the hosted pilot. On 24 September 2026, a live browser check loaded 77 Arc-filtered directory entries, received a successful relay response, displayed a pairing QR code and cancelled pairing with focus restoration. No wallet approval, signature or payment was performed. End-to-end approval on real wallets and payment compatibility remain separate acceptance steps.

WalletConnect pairing requests Arc Mainnet. An installed browser wallet can connect on its current network; a separate **Switch to Arc** action requests a network change and, if needed, adds the reviewed Arc configuration. The returned chain ID is checked. No USDC balance or real payment is displayed until settlement is configured.

The WalletConnect SDK persists protocol session material in browser storage. Enclave does not put API keys, prompts or provider credentials into that storage. Wallet state is never trusted as server-side authentication.

## Target payment flow

1. Select **Connect wallet**, choose a wallet or scan a WalletConnect QR code on mobile.
2. Connect to the supported payment network. Display the account, network and USDC balance.
3. Before a paid request, show the exact USDC amount and recipient. Request a bounded payment authorization in the wallet.
4. Submit the authorization through the existing payment protocol, display settlement state, then show the inference result and receipt when successful.
5. If a request is interrupted or settlement is uncertain, recover the existing operation without requesting a second payment authorization or starting duplicate inference.

Connection alone does not authorize payment or authenticate a server-side user session. Account and network changes must invalidate any pending signing context.

## Wallet coverage

The custom chooser loads the official WalletConnect Explorer API in pages of 100, filtered by connection network and Sign v2 support, with search, pagination, QR connection and mobile links. The acceptance target remains at least 50 distinct compatible wallets. Prioritize common wallets such as MetaMask, Trust Wallet, Rainbow, Rabby and OKX where compatible.

The wallet directory is not evidence that every listed wallet supports our payment signature. Before release, record the actual compatible wallet list and a connection/signature compatibility matrix. Count distinct wallets, not extension and mobile variants of one wallet. Test the main desktop and mobile journeys and publish any exceptions.

The current backend x402 v2 path supports EIP-3009 authorizations from externally owned accounts. ERC-1271 smart wallets and ERC-6492 counterfactual accounts are not currently supported. Reject unsupported account types before requesting payment; do not advertise them as payment-compatible until their backend path is implemented and verified. See [the payment protocol](../_backend/docs/x402-v2.md).

## Required deployment configuration

- WalletConnect/Reown project ID and the `enclaveagent.tech` domain allowlist. The application metadata already uses that domain.
- Arc Mainnet is selected; the official RPC and USDC EIP-712 domain pass the read-only preflight. Production RPC capacity, finality policy and transaction acceptance still need verification.
- Deployed Enclave contracts, recipient and funded relay wallet, with their addresses published in the deployment record.
- Server-side authentication and wallet ownership binding; an operator API key must not be shipped to public browsers.

## Acceptance

Verify successful payment, user rejection, insufficient funds, unsupported network/account, expired authorization, account changes, duplicate submission, timeout and restart recovery. Confirm the displayed amount and recipient match the signed authorization. Preserve the same request, nonce and payload across retries. If inference fails after settlement, show the payment transaction and failure state accurately; do not imply an automatic refund.

Test with a test token first, then perform an explicitly authorized small real-USDC acceptance transaction. A wallet modal or new domain alone does not enable production payments or complete E1.

References: [WalletConnect Sign Client](https://github.com/WalletConnect/walletconnect-monorepo/tree/v2.0/packages/sign-client), [Explorer API](https://docs.reown.com/cloud/explorer), [EIP-6963 discovery](https://eips.ethereum.org/EIPS/eip-6963).
