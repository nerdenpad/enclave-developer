# Contract tests and audit scope

Run from the repository root:

```sh
npx tsx scripts/contracts-test.ts
npx tsx scripts/contracts-test.ts --coverage
npx tsx scripts/contracts-test.ts --match-test testStrangerCannotDrainApprovedPayerAllowance
```

The launcher uses a locally installed `forge`, or the existing Foundry Docker image if Forge is absent. Docker must be running for the fallback. Tests execute in Forge's isolated EVM and do not connect to the development Anvil, database, or production network. The Solidity compiler is pinned to `0.8.28` in `foundry.toml`; the first run may download this compiler. `test/TestBase.sol` supplies the small test-only cheatcode interface, so no `forge-std` checkout is needed. Deployment scripts are excluded from this test compilation because their independent `forge-std/Script.sol` dependency is not vendored.

## Verified on 2026-09-20

131 tests passed, no failures or skips, with Solidity 0.8.28. This includes immutable TCB policy bindings, standard x402 transfer authorizations, atomic mandate accounting, replay/cancellation defenses, and canonical funding-block guards for owner recovery. The unverified confidential-transfer hook is restricted to local chains 31337/1337. No development chain or database was used by the Forge run.

## Coverage measured on 2026-09-20

131 tests passed, no failures or skips. Six property tests each ran 256 generated examples. The normal test run uses the configured optimizer and IR compilation. Coverage uses Forge's unoptimized non-IR compilation for accurate source mapping and excludes test harnesses:

| Production sources | Covered |
| --- | --- |
| Lines | 495 / 495 (100%) |
| Statements | 478 / 478 (100%) |
| Functions | 82 / 82 (100%) |
| Branches | 276 / 303 (91.09%) |

Uncovered branches are primarily ERC-20 calls returning `false` rather than reverting; the concrete ENCL and MockUSDC implementations revert on failure. The suite verifies rollback for reverting token calls and for a confidential adapter returning `false`. Coverage measures executed source, not fulfillment of absent product features.

## Scenarios

- ENCL supply conservation, 80/10/5/5 rounding, coincident genesis recipients, mint event totals, finite/infinite allowances, failed transfers and self-transfers.
- Staking custody and accounting, partial withdrawals, generated deposit amounts, unauthorized withdrawals, missing allowance, zero values.
- Registry deposits, duplicates, invalid hashes/bps, exact timelock boundary, owner permissions, revocation and single stake refund, local-only bootstrap gates.
- Immutable TCB policy hash/version, capability discovery, exact model/code/policy approval, legacy-listing rejection on the policy-aware path, timelock, revocation and failed-stake rollback.
- Signed receipts, every authenticated field, immediate rejection after revocation, wrong signer, key rotation, malformed and malleable signatures, contract and chain domain separation.
- Settlement moving actual mock USDC, payer authorization, allowance-drain regression, replay across both paths, transaction rollback and retry, rejected confidential hooks.
- Vault distribution, dust, coincident recipients, administration, ownership transfer, buyback intent behavior.
- Daily mandate aggregation, exact limit, UTC rollover, lowered limits, same-day reopening, owner isolation, invalid inputs.
- Atomic agent/model settlement, provider fee accounting, zero/full basis-point boundaries, rollback after the provider payment if the vault payment fails.
- EIP-3009 payer signatures, canonical recovery IDs 27/28, real balance debit without allowance or minting, strict validity boundaries, nonce replay, chain separation, and rejection of untrusted routing substitution.
- x402 TransferWithAuthorization with an independent client nonce, malformed/high-S signature rejection, canceled nonce rejection, front-run deposit recovery without a second debit, insufficient pooled funds, and atomic funding-block canonicality with exact 256-block boundary tests.
- Proportional USDC staking rewards, late deposit and withdrawal boundaries, no-staker quarantine, repeated claims, and generated reward-conservation cases.
- Reserved treasury buybacks, measured adapter input/output, slippage and deadline enforcement, allowance cleanup, and protection of undistributed fees.

## Economic interfaces

Deployment wires `AgentMandate.setSettlementMeter(meter)`, `UsageMeter.setMandate(mandate)`, `UsageMeter.setModelRegistry(registry)`, and `InsuranceStaking.configureRewards(usdc)`.

`settleAgent(payer, agent, amount, paymentId)` and `settleModel(payer, amount, paymentId, listingId, agent)` perform mandate reservation and payment in one transaction. The payer must own the mandate. A zero agent is an ordinary payment. The registry's `listingBps` explicitly means the provider's share of the payment; it is sent directly to the approved listing's provider, with the remainder going to FeeVault. `listingVolume` and `providerEarned` record realized per-listing amounts. Revoked/unapproved listings cannot be paid using this path.

`settleAuthorized(from, amount, paymentId, listingId, agent, validAfter, validBefore, signature)` receives already funded USDC through EIP-3009, then applies the same accounting atomically. The token authorization signs `ReceiveWithAuthorization(from,to,value,validAfter,validBefore,nonce)` where `to` is UsageMeter and `nonce` is `paymentId`. The local mock uses the domain `USD Coin`, version `2`. A real deployment must verify its USDC domain/ABI.

**Trusted relay limitation:** EIP-3009 does not sign the model/agent routing fields. Therefore only the meter owner (the gateway relay) or the payer can submit this method. The gateway must bind routing to the payer's accepted payment intent. Other relayers cannot alter the routing or remove the mandate. An external payer's mandate must be opened by that payer; the gateway cannot silently take ownership of another wallet's mandate.

`settleTransferAuthorized` accepts the standard x402 `TransferWithAuthorization` signature with its independent client nonce. `settlePrepaidTransfer` is an owner-only recovery function taking the same authorization plus `FundingBlock { number, hash }`. It verifies that the funding block remains canonical within EVM's 256-block `blockhash` window. The owner must first prove the exact canonical token transaction and its `Transfer` + `AuthorizationUsed` events; token `authorizationState` alone also includes cancellations and is insufficient. The gateway only recovers authorizations durably admitted while unused before funding, and rejects public pre-funding claims. See [the x402 guide](../docs/x402-v2.md) for the complete supported subset and operator boundaries.

Staking checkpoints the measured USDC balance before changing stake. Rewards already received by InsuranceStaking remain attributable to the old stake balances. FeeVault funds become staking rewards when distributed into InsuranceStaking. Deposits received with no stakers are quarantined as `unallocatedRewards` and can only be returned by the owner; a later depositor cannot capture them. Integer rounding dust remains in custody.

Buybacks are opt-in. `setBuybackReserveBps` accepts 0..1000 basis points of the treasury's 80% share, default 0. Distribution leaves this reserve in FeeVault and emits/returns the **net** treasury transfer. `executeBuyback` can spend only `reservedBuyback`, uses a configured `IBuybackRouter.swapExactInput` adapter, checks a positive minimum output and deadline, measures actual input/output balances and clears token allowance. No live DEX address or market quote is supplied by this implementation. The legacy `queueBuyback` method remains an intent event for compatibility; it does not execute a swap.

## Confirmed defects corrected

1. Genesis allocations overwrote earlier balances when recipient addresses coincided. The local deployment passes the same address four times and therefore previously gave it only 5% of the declared supply. Allocations now add up and emit their individual mint amounts.
2. Anyone could call `UsageMeter.settle` against a payer's existing token allowance, or submit confidential settlement in that payer's name. Both paths now require the payer as caller. The additive `settleAuthorized` path supports externally signed EIP-3009 payments through the owner relay or payer, with the routing limitation described above.
3. Registry bootstrap methods could bypass timelock and undo revocation on any network. They are now restricted to local chain ID 31337. Other networks must use the timed approval path; revocations there remain irreversible.
4. Receipt recovery accepted high-S malleable signatures. Recovery now requires canonical secp256k1 S values.
5. A receipt signed before a chain-ID change remained valid because the domain separator was permanently cached. The cache now applies only to its original chain. The regression test was observed failing against the old implementation before the fix.
6. Zero-address vault/token dependencies, a zero-address vault ownership transfer, and zero-amount withdrawals are rejected.

## Requirements still not implemented by these contracts

- The confidential-transfer interface is a placeholder without a pinned Arc precompile ABI. `MockConfidentialTransfer` emits an event and returns success without moving USDC or proving a shielded amount. The contract restricts this unverified hook to local chains 31337/1337. `testLocalConfidentialMockOnlyExercisesHookNotTransfer` explicitly records its limitation; external-chain direct calls are rejected. These tests do not establish explorer privacy or auditor view-key access.
- Confidential settlement cannot enforce a hidden amount mandate without a real confidential-transfer adapter that attests the debit. The public and EIP-3009 paths now enforce agent mandates atomically; the confidential development hook does not.
- `listWithPolicy` stores an immutable policy hash and version in addition to the model/code pair. The policy-aware approval query checks all four fields. Vendor-root CPU/GPU verification is still absent from Solidity, and receipt v2 still authenticates the signer's model/code assertion. Legacy listings cannot be upgraded in place; a new pair must use the policy-aware listing path.
- Local bootstrap restore can reapprove a refunded listing without a new provider deposit. It remains explicitly local-only and must not be used to demonstrate production staking enforcement.
- Insurance loss waterfall/slashing policy is not specified or implemented. Staking now holds principal and accrues/claims USDC fee rewards; it does not claim to insure losses automatically.
- `MockUSDC` remains freely mintable test currency. Its EIP-3009 implementation tests the same payer authorization interface without a real asset. Successful local tests do not establish integration with Arc mainnet/testnet or a live buyback venue.

These missing integrations require protocol and external-service work. Passing local unit tests is not production acceptance of the PDF's confidentiality and hardware-attestation requirements.
