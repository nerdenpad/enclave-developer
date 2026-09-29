# NEAR Gateway release path

NEAR remains the selected GPU inference provider. The application gateway, website and Arc worker can run on the existing server. NEAR evidence is verified for the remote inference path; application request encryption terminates at our gateway.

The current direct `*.completions.near.ai` integration is a development path. NEAR documents direct verification as experimental and recommends `cloud-api.near.ai` for new production verification workflows. The Gateway integration must verify fresh gateway evidence, every returned NEAR model candidate required by policy, same-connection TLS binding and the response signature against the appropriate preflight signer. A `gateway` signature alone does not prove model-level response binding.

Before release, review and version the accepted measurements and image provenance. Reject missing model candidates, unapproved measurements, expired evidence, absent or ambiguous signatures and changed TLS peers. Persist the exact verification evidence with the encrypted transcript and receipt reference.

Then register and approve the selected model, application code and policy binding in Arc ModelRegistry. Test one hosted inference, signed receipt and confirmed Arc anchor; verify restart and retry recovery. Public payments remain disabled until a separately approved small real-USDC acceptance test passes without duplicate settlement or execution.

`npm run registry:prepare:arc -- --model MODEL_ID --code-hash 0x... --policy-hash 0x... --policy-version N` performs a read-only Arc preflight against the ignored `.local/arc-deployment.json` record. It checks the reviewed registry owner and stake token, duplicate listings, the provider's one-ENCL stake and gas balance, then prints exact wallet transaction requests. It never loads private keys, signs or broadcasts. Use only final reviewed release hashes. The registry owner must separately approve the confirmed listing after its one-hour timelock; local bootstrap approval is unavailable on Arc Mainnet.

The production configuration must require the verified NEAR path, Arc network and user authentication, and must reject echo or local-test settings. The public status and receipt UI should describe only evidence established by the deployed path.

Official references: [NEAR Gateway verification](https://docs.near.ai/cloud/verification/cloud-api), [direct completions limitations](https://docs.near.ai/cloud/experimental/direct-completions), and [Arc network parameters](https://docs.arc.io/arc/references/connect-to-arc).
