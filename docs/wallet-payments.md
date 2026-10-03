# Wallet connections and real USDC

The final domain is **enclaveagent.tech**. The selected payment network is **Arc Mainnet (5042)**. The backend runs in production mode with a historically accepted NEAR + Arc release manifest. New payment/inference admission is blocked pending strict review and fresh acceptance of the current provider workload. Wallet connection is implemented separately from payments. Public checkout is enabled at the approved **0.10 USDC per request**. A real operator WalletConnect browser session passed wallet sign-in, navigation/reload, one payment, one inference, receipt export and independent Arc verification on 1 October. Web QA fixes were deployed on **3 October 2026**. Manual wallet acceptance is reopened after a detailed OKX failure report; a real OKX retest is still pending. Live settlement interruption, signer rotation and model revocation acceptance remain open, so E1 public launch remains open. See the [Arc deployment profile](arc-deployment.md) and [release progress](release-progress.md).

## Implemented connection

The dashboard uses the direct WalletConnect Sign Client, with an Enclave-owned dialog and QR renderer. Reown AppKit is not installed. Browser extensions are discovered through EIP-6963, with a legacy provider fallback. Connection only reads accounts and chain ID; it does not request a payment signature, send a transaction or authenticate a gateway user.

Account and network changes update the browser-wallet display. A WalletConnect approval change invalidates the session and requires reconnection. Cancellation ignores late approvals and closes any late remote session. The dialog supports keyboard navigation, Escape and focus restoration.

Browser extensions work without a Project ID. Remote pairing and the catalog use the public `VITE_WALLETCONNECT_PROJECT_ID` in `frontend/.env.local` at build time. Configure the project and domain allowlist through WalletConnect/Reown; see [the Explorer API requirements](https://docs.reown.com/cloud/explorer). The supplied project is configured on the accepted hosted deployment. On 24 September 2026, a live browser check loaded 77 Arc-filtered directory entries, received a successful relay response, displayed a pairing QR code and cancelled pairing with focus restoration. No wallet approval, signature or payment was performed in that historical check; the later protocol and manual acceptance records are described below.

WalletConnect pairing requests Arc Mainnet. An installed browser wallet can connect on its current network; a separate **Switch to Arc** action requests a network change and, if needed, adds the reviewed Arc configuration. The returned chain ID is checked. No USDC balance or real payment is displayed until settlement is configured.

The WalletConnect SDK persists protocol session material in browser storage. Enclave does not put API keys, prompts or provider credentials into that storage. Wallet state is never trusted as server-side authentication.

## Wallet sign-in

After connecting on Arc, choose **Sign in with connected wallet**. This requests a [SIWE / ERC-4361](https://eips.ethereum.org/EIPS/eip-4361) message for the site's exact HTTPS origin and dashboard URI, valid for five minutes. It is an off-chain login signature, not a transaction or payment authorization. Browser extensions and WalletConnect use `personal_sign`; existing pairings may need reconnection to approve this capability.

The backend verifies the signature against its stored message and atomically consumes the nonce. Each wallet has a stable private workspace identity. A random session lasts 30 minutes; only its hash is stored in PostgreSQL. The browser keeps the bearer in memory and a durable copy in a Secure, HttpOnly, SameSite=Strict cookie scoped to `/api/v1/auth/wallet`. Origin-checked POST resume verifies the selected address and existing expiry before restoring the workspace. Navigation and reload do not require a new signature or extend expiry. Logout revokes the session; changing the wallet or network clears the workspace. A public selection hint is stored in localStorage, but no login token, API key or payment signature is stored there.

Login supports EOAs only. It grants no balance, administrative privileges or access to another owner's records. Public wallet sessions can inspect their own workspace and use the configured Arc authorized-payment deployment. Agent and administrative mutations remain unavailable to public wallet sessions. Login itself is not a payment or hardware proof.

Published and checked on 25 September 2026 at `enclaveagent.tech`: an unfunded browser wallet fixture signed in, loaded its empty workspace, could not submit a pilot settlement, and lost access after an account change. The PostgreSQL integration covered concurrent replay, stable ownership across logins, separate identities, expiry and revocation. The hosted WalletConnect check still returned 77 catalog entries and a working QR relay. These historical checks did not exercise an actual wallet-app payment.

On 1 October 2026, the browser completed actual WalletConnect pairing and SIWE
login, returned from home to the dashboard, and restored the same login after
reload without another signature. The operator wallet approved one **0.10 USDC**
authorization; the browser sent one settlement and one paid inference request,
verified the response/receipt, and exported JSON and owner CSV. Canonical Arc
events and policy version 2 passed independent checks. The wallet key remained
in a protected local operator helper; no key was sent to the browser or server.
This exercises the real WalletConnect protocol with an operator EOA, not a
physical wallet-app UI.

The project owner confirmed manual wallet acceptance on **3 October 2026**.
Acceptance was subsequently reopened following the detailed OKX failure report
for **2 October 2026, 22:16–22:24 Moscow time**. Corrective web fixes were deployed
on **3 October 2026**. A real OKX retest is pending current provider admission
acceptance; the earlier confirmation remains in the
[acceptance history](release-progress.md#manual-wallet-regression--3-october-2026).
The 3 October canonical Arc readback found the reported payment's exact intent
unsettled in UsageMeter at block **24086493** with **12 successor blocks**.
This payment-specific check does not establish the status of other wallet transfers;
its payment ID and scope are retained in that acceptance history.
Interruption during live settlement and recovery, signer rotation and model
revocation remain separate open acceptance scenarios.

Across the API and browser acceptance runs, confirmed usage is **three calls and
0.30 USDC**, each with its own intent and one settlement. The third API request
returned complete final content `READY` with `finish_reason: stop` under reviewed
provider policy version 5, thinking enabled and a 512-token cap. The earlier
32-token protocol tests could truncate reasoning and do not establish complete
final-answer quality.

Run the additive database migration before setting `WALLET_AUTH_ORIGIN=https://enclaveagent.tech` on the API. Without this setting, public login is disabled. Login requests require the matching Origin header and have a 4 KB body limit, a 120-request/minute per-process ceiling, five outstanding challenges per address and ten active sessions per address. Multi-replica or high-volume deployments need a shared perimeter rate limiter. Test PostgreSQL behavior with `node --env-file=.env.demo --import tsx scripts/test-wallet-login.ts` from `_backend`; it creates and removes only a random test schema.

## Payment release configuration

An explicit build-time flag and reviewed UsageMeter, verifier, receipt-signer addresses and maximum payment amount are required. See `frontend/.env.example`. Missing or invalid configuration disables checkout; changing a flag alone does not supply authentication or deploy contracts.

The dashboard uses the v1 `/v1/x402/settle` receive-authorization protocol with Arc's `USDC` / `2` domain and six-decimal amounts. The backend's separate x402 v2 transfer-authorization protocol remains available to API clients. Do not interchange their signatures or nonces.

Checkout compares the challenge and current gateway against deployment pins, displays the full recipient and exact amount, and signs only after explicit confirmation. It rejects changed accounts/networks, invalid signatures and expired authorizations. Retries within the same open workspace preserve the authorization and request. A confirmed settlement is not submitted again if inference needs retrying. Browser state is not recovered after a page reload; use server payment history to reconcile uncertain payments. No automatic refund is promised.

## Release acceptance flow

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
- Arc Mainnet is selected; the official RPC and USDC EIP-712 domain pass preflight. Real settlement and receipt anchors passed canonical event checks with the configured positive confirmation policy. Operational RPC capacity and remaining live failure/reorganization scenarios still need acceptance.
- Deployed Enclave contracts, recipient and funded relay wallet, with their addresses published in the deployment record.
- Enable the migrated server-side SIWE login and verify ownership/session expiry; an operator API key must not be shipped to public browsers.

## Acceptance

Verify successful payment, user rejection, insufficient funds, unsupported network/account, expired authorization, account changes, duplicate submission, timeout and restart recovery. Confirm the displayed amount and recipient match the signed authorization. Preserve the same request, nonce and payload across retries. If inference fails after settlement, show the payment transaction and failure state accurately; do not imply an automatic refund.

Test with a test token first, then perform an explicitly authorized small real-USDC acceptance transaction. A wallet modal or new domain alone does not enable production payments or complete E1.

References: [WalletConnect Sign Client](https://github.com/WalletConnect/walletconnect-monorepo/tree/v2.0/packages/sign-client), [Explorer API](https://docs.reown.com/cloud/explorer), [EIP-6963 discovery](https://eips.ethereum.org/EIPS/eip-6963).

Wallet navigation restoration is distinct from payment recovery: it never recreates or submits a payment. Browser extensions are restored using `eth_accounts`; WalletConnect restores only the remembered unexpired topic. Page cleanup detaches listeners without deleting the remote session. Explicit disconnect deletes the selection and closes that session.
