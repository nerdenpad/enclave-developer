# Payment launch preparation

Reviewed on 24 September 2026. WalletConnect is already configured under the supplied project. No replacement account, disposable email address or additional Project ID is needed. Pricing approval is deferred; paid checkout stays disabled.

## Operator inputs

Provide public addresses for four distinct Arc Mainnet wallets:

| Role | Suggested initial USDC | Purpose and access |
| --- | ---: | --- |
| Administrator | 2 | Contract deployment and administration. Customer-controlled signing; do not install its key in the public application or API. |
| Relay | 10 | Network fees for payment submission and receipt anchoring. Use a separate limited-balance server signer; the customer can retain their original funding wallet. A public address alone cannot sign. |
| Treasury | 0 | Receives the project's revenue allocation. Keep custody with the customer; a native-fee balance will be needed later to send withdrawals. |
| Test payer | 3 | Separate EOA for small, explicitly approved acceptance payments. Customer approves these from their wallet. |

Total suggested initial wallet funding: **15 USDC**, excluding model inference, hosting and any bridge/withdrawal charges. These are working reserves, not measured total expenditure or a guarantee of duration. Test funding may change after the tariff is approved. Confirm addresses and the Arc network before funding. Never send recovery phrases or private keys in chat or commit them to Git.

Copy `infra/arc/wallets.example.json` to the ignored `.local/arc-wallets.json`, insert only the four public addresses, then run:

```sh
npm run check:arc-wallets -- .local/arc-wallets.json
```

This checks chain ID, distinct addresses, balances at one consistent block and EOA compatibility for the deployment/relay/test roles. Exit code 2 means a suggested balance or account requirement is not met; exit code 1 means invalid input or a failed check. It sends no transaction and does not verify ownership. Native and ERC-20 USDC are one balance, not two sources of funds.

## Network cost evidence

`npm run budget:arc` compiles the current Solidity sources and obtains read-only constructor estimates from Arc. It uses stand-in constructor addresses, never deploys MockUSDC, never loads a signing key and never submits a transaction. Its output includes bytecode hashes for repeatability. It is not a deployment command.

On 24 September 2026, after separating relay authority, the seven contract creations totalled 6,463,529 estimated gas at 20 Gwei: **0.12927058 USDC**. Adding an assumed 2,000,000 gas for configuration and a fivefold fee buffer gives **0.8463529 USDC**. The administrator's 2 USDC reserve rounds this up with additional headroom. Configuration gas is an allowance, not a simulation of a finished deployment. Supply, allocation and policy constructor arguments remain subject to approval.

For operating planning, 750,000 gas per complete paid request at five times the observed fee gives 0.075 USDC. This is an allowance, not a measured request cost or customer tariff. A 10 USDC relay reserve covers about 133 such allowances; failures, recovery and distribution also spend gas. Re-estimate with actual wallet addresses and approved parameters before signing. Network fees can change beyond that buffer. [Arc transaction fee guidance](https://www.arc.io/blog/sponsored-transactions-on-arc-with-usdc-as-gas).

## Implemented safeguards

- UsageMeter separates the deployment owner from its payment relay. The owner calls `setRelay`; replacing the relay revokes the previous relay's sponsored settlement and recovery authority. Setting it to zero pauses those operations while retaining payer self-submission. The relay cannot change contract configuration. Until explicitly changed, the deployment owner is also the initial relay.
- `scripts/provision-arc-relay.mjs` creates a dedicated Linux signer as the service user, without printing the private key or overwriting an existing signer. API and worker can load it through `RELAY_KEY_FILE`; remove `DEPLOYER_PRIVATE_KEY` when using this option. The file must be private, owned by the service user and not a symlink. The public Anvil key is rejected on Arc Mainnet.
- Newly prepared Arc relay transactions are limited to 1,000,000 gas, 20–100 Gwei per gas and at most 0.10 USDC in maximum gas cost, with no native-value transfer. These are operational limits, not the customer tariff or a daily spending budget. Existing journaled transactions retain their original bytes for recovery.
- Browser checkout creates an expiring EIP-3009 receive authorization for an exact payer, recipient, amount and nonce. It checks the signature, selected account/network and reviewed deployment pins. Retries in the same open workspace reuse the authorization and original request. A page reload does not restore this browser state; reconcile server payment history before preparing another payment.
- The hosted pilot has a separate, unfunded software relay signer and a verified encrypted backup. It is not enabled in the running payment configuration. Customer administrator, payer and treasury keys remain with the customer.

## Remaining implementation and acceptance

- Produce a mainnet deployment plan with explicit owners and addresses. Existing `contracts:deploy` is a local-only workflow using mock contracts and bootstrap approvals; it must not be repurposed by changing its RPC. Deploy under customer control and explicitly configure the dedicated relay.
- Confirm revenue allocation. FeeVault currently splits funds 80/10/5/5, and model listings can take an additional provider share first. Do not treat all client payments as treasury revenue, secretly route allocation addresses to one wallet, or infer a new token supply from budget examples.
- Approve a price after measuring model costs, network fees, failed-request costs and the treasury share. The 0.10 USDC development price is not a commercial tariff. No price or fee allocation was changed.
- Complete real-token settlement/recovery acceptance. Browser payment signing is implemented behind a disabled release flag. Public EOA login now uses a separate SIWE signature and expiring session; connecting alone does not authenticate a user. Public logins cannot spend pilot resources. The receipt signer remains in software until confidential infrastructure is available; keep that limitation visible.
- Verify hosted inference before accepting customer payments. The recorded NVIDIA NRAS 403 remains an acceptance blocker until a fresh successful check proves resolution. WalletConnect readiness does not resolve it.
- Keep treasury-to-relay replenishment manual initially. Automatic replenishment, balance alerts and cumulative daily spending caps are not configured. They require explicit limits and an agreed funding mechanism; never give the service wallet unrestricted treasury access.

The four customer addresses and their initial balances have been checked read-only. Deployment and paid tests still require customer signing, funding of the dedicated relay, approved parameters and a working inference path. The operator need not configure WalletConnect again.
