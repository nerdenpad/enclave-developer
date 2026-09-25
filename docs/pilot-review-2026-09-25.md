# Enclave deployment review — 25 September 2026

The hosted application is a development pilot. It is not the E1 production release.

| Reported issue | Finding |
| --- | --- |
| Local Anvil contracts | Confirmed. The gateway uses chain 31337. Selecting Arc in a wallet does not migrate gateway contracts. |
| Mock USDC | Confirmed. Public real-USDC payments are disabled; current settlement is for local tests. |
| Production switch | Incomplete diagnosis. The current gateway configuration supports only the development TEE adapter and rejects production. A hardware gateway adapter still needs implementation/integration and validation. Changing a flag cannot establish those guarantees. |
| Software gateway keys | Confirmed. The conventional VPS does not establish hardware custody or attestation-bound release of gateway keys. |
| Simulated NEAR inference | Not established. The backend has a real NEAR adapter with hardware-evidence and TLS checks. Old website preview copy incorrectly described the current backend as a simulation. Current verified inference is blocked: NVIDIA's JWKS and GPU attestation endpoints returned HTTP 403 from the VPS during this review. NEAR's model endpoint returned 200; that is not proof of a successful inference. |
| No anchored receipts | No Arc anchoring is deployed. The hosted database had zero receipts at review time, so there is no completed hosted receipt to demonstrate. Local anchoring code exists, but this is not evidence of an actual production anchor. |

The receipt signer is an off-chain signing identity, not itself a deployed contract. A contract's address does not prove which chain it belongs to; the network configuration and transaction evidence matter.

## Changes made

- Wallet selection is restored with read-only account checks or an existing WalletConnect session, without a new pairing request. Disconnect remains explicit.
- A signed wallet login survives navigation and reloads for its original 30-minute lifetime. The durable login credential is held in a Secure, HttpOnly, SameSite=Strict cookie; JavaScript storage holds only the public wallet selection. Restoring does not extend expiry or authorize a payment.
- X and Telegram links point to the supplied official accounts.
- Outdated simulation claims in the FAQ and related pages were replaced with the current pilot boundaries.

## Remaining release work

1. Restore the NVIDIA/NEAR verification path and complete a fresh, verified inference. Review and renew the provider policy before its expiry; never skip attestation checks.
2. Confirm pricing and the operator's funded signing arrangements, review contracts, deploy and configure them on Arc, then check real USDC settlement with explicitly approved small amounts.
3. Demonstrate receipt anchoring and verification on the selected public network, including retry and duplicate-payment protection.
4. Implement/integrate the hardware gateway adapter, then deploy and verify hardware custody and attestation-bound key release. Moving to a GPU provider alone does not prove this property.
5. Run the complete E1 acceptance path before describing the product as live.

The public walkthrough is a pilot UI overview. It must not be captioned as a successful production payment or a completed GPU inference while those paths remain unverified.

## Validation

Frontend unit tests: 164 passed. Wallet-auth API unit tests: 8 passed. The browser suite and added navigation regression exercised 24 scenarios. Frontend/backend type checks and the isolated PostgreSQL login integration passed. On the hosted domain, an unfunded EOA test driver needed one connection approval and one login signature across a home-page round trip and reload; changing accounts revoked its server access. No paid inference or chain transaction was performed in these checks. Real wallet-app compatibility remains a separate check.
