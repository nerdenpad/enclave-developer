# Release progress — 3 October 2026

The hosted backend runs the accepted NEAR + Arc production profile. The technical
payment-to-receipt path passed acceptance on 1 October 2026. Manual wallet
acceptance passed, confirmed by the project owner on 3 October 2026. Public E1
launch remains open until the remaining live failure acceptance is complete.
A real browser WalletConnect payment journey also passed on 1 October.
The commercial price is approved at **0.10 USDC per request**. A third paid test
returned a complete final answer; aggregate acceptance usage is **three calls and
0.30 USDC**. Public checkout is enabled on the published frontend.

## Completed

- The site and API are served through HTTPS at [enclaveagent.tech](https://enclaveagent.tech).
- The selected inference route is experimental direct NEAR. CPU/GPU evidence,
  workload policy, TLS identity and the signed request/response transcript are
  checked before a result is accepted.
- Fresh CPU/GPU attestation passed through the hosted API's verifier runtime.
  Local NVIDIA verification uses a reviewed, pinned NVAT distribution and exact
  whole-node profiles. Both observed nodes returned eight verified GPUs; this
  hardware check did not submit a model request or a payment.
- Serving policy version 2 is registered in Arc ModelRegistry, approved after the
  one-hour timelock and activated in the application. The deployed API uses this
  serving identity.
- Wallet sign-in, encrypted sessions and authorized USDC settlement are implemented.
  The acceptance runner exercised wallet sign-in against the hosted API.
- The payment challenge now identifies UsageMeter as the recipient of an authorized
  payment. Public model listings are restricted to the configured chain and
  deployment. Worker RPC requests are paced without overlapping polling cycles.
- The operator acceptance runner preserves one request, payment authorization and
  journal, independently checks the resulting proof and confirmed chain events,
  and supports recovery without an automatic second paid request.
- One real hosted request completed through the selected direct NEAR endpoint.
  Its exact request/response transcript, provider signature, fresh CPU/GPU
  evidence and application receipt passed verification. Archived hardware
  evidence was independently verified again using current signed collateral.
- The customer acceptance wallet paid **0.10 USDC** on Arc. The corresponding
  receipt was anchored and verified against the configured ModelRegistry policy,
  signer and canonical transaction, with at least 12 successor blocks.
- API and worker were restarted. Repeating the original completed request
  returned the identical encrypted answer, evidence and receipt. Database and
  canonical chain snapshots confirmed **one debit, one usage call and one
  settlement event**, with unchanged balance and result after replay.
- The matching release manifest and evidence archive were reviewed and installed.
  Production startup passed contract, policy, persisted payment, archived
  hardware and fresh provider checks. The public API reports
  `stage: production`, `productionReady: true`, `releaseProfile: near-arc`.
- Home, dashboard and `/status` display the reported deployment and network.
  Public browser checkout is enabled at the approved **0.10 USDC** price. The
  reviewed frontend was installed with atomic asset publication and server
  output exchange. Public JavaScript hashes/MIME, the home/dashboard/status/
  verify pages and API health passed deployment checks.
- Remote requests now commit a durable dispatch claim before external inference.
  An ambiguous provider attempt cannot be executed again with that payment or
  intent. Fault-injection tests passed for response loss, concurrent callers,
  publication rollback and restart. Four tests with actual PostgreSQL used a
  disposable schema and signed provider fixtures; they submitted no paid model
  request or chain transaction.
- Runtime admission and result publication check the current verifier signer
  and USDC routing at one canonical block. Changed wiring or unavailable RPC
  blocks new admissions. Signer-change and transport-failure unit tests passed.
- A real WalletConnect browser session signed in through HTTPS, returned from
  home to the dashboard and survived reload without another sign-in signature.
  It approved one additional **0.10 USDC** payment and submitted one paid model
  request. The browser verified the response and receipt signature, opened the
  receipt and exported JSON and owner CSV. Independent read-only verification
  confirmed the Arc settlement event, receipt anchor and policy version 2 with
  more than 12 successor blocks. The wallet key stayed in the local operator helper;
  this protocol test did not exercise a physical phone wallet or extension UI.
- A third real **0.10 USDC** request returned final content exactly `READY` with
  `finish_reason: stop`. Provider reasoning was separate from final content.
  The strict reviewed provider policy was renewed to version 5, with thinking
  enabled and a 512-token cap. Its receipt and canonical Arc settlement/anchor
  passed verification. Production restart independently replayed its archived
  hardware evidence and passed fresh provider checks; public health reported
  ready and the service recorded zero automatic restarts.
- The first two 32-token requests established the payment, transcript, receipt,
  browser and recovery paths. Their reasoning could exhaust that small cap;
  they are not evidence of a useful complete final answer. The third request
  establishes complete-answer acceptance. Total confirmed usage is **three calls
  and 0.30 USDC**, with one settlement for each intent.
- Published build modules, hero video, text/image reveals, scroll scenes, FAQ
  and mobile animations passed four browser checks. Original Lovable motion
  algorithms and timings run at their normal **1×** speed. The checks also cover
  reduced motion and intercept backend requests locally. Footer X and Telegram
  icons were checked for centering, link targets and keyboard focus on desktop
  and a 390-pixel mobile viewport.
- Manual wallet acceptance: passed, confirmed by the project owner on
  3 October 2026. Live settlement interruption, signer rotation and model
  revocation remain separate open acceptance scenarios.

Arc records:

| Operation | Confirmed transaction |
| --- | --- |
| Register serving policy | [ModelRegistry listing](https://explorer.arc.io/tx/0x7826a061ff8248cbee2d2063a465208cb0af50808c93b84bac6fc418ee0d10fd) |
| Approve serving policy | [ModelRegistry approval](https://explorer.arc.io/tx/0x2649bdf3aed86bd48a650e7e61b663b4b4b6cb6aa5ca7a3bb217538c19a809a2) |
| Settle 0.10 USDC | [UsageMeter settlement](https://explorer.arc.io/tx/0xaf1de665791e94a8f87f74e00edfdbf7f1cd56f8ec32bf98e0a57c36cbc73f33) |
| Anchor accepted receipt | [AttestationVerifier anchor](https://explorer.arc.io/tx/0xeefdee7f01fd42a28546db8de2d0052f4b6a7711dd03684b6063b2b30ff33e5a) |
| Settle browser 0.10 USDC | [WalletConnect settlement](https://explorer.arc.io/tx/0xac695390ce47c64ceab1181452689441d6b2ba50c2beaabea32261c6f884ebde) |
| Anchor browser receipt | [WalletConnect receipt anchor](https://explorer.arc.io/tx/0x5e62b9500706aca5547380aa20d80a5e2400b79b83f5cf1164ccd6b14e599675) |
| Settle complete-answer 0.10 USDC | [Complete-answer settlement](https://explorer.arc.io/tx/0xd8bcf6f8ebef596afa48c1101dac49f7d3ecd0d083d77878227a8ea3fe2a906a) |
| Anchor complete-answer receipt | [Complete-answer receipt anchor](https://explorer.arc.io/tx/0xc53538efb55428ea92503fe7e1d9cde5228c648d5631d1688d14ae07eb42d08d) |

The complete-answer payment ID is `9c094791-d8ae-4fb4-b68c-ef4abe1a957b` and
its signed receipt hash is
`0x746594f5a2599e386e3a78a8079544f2d8cbddc696ad0a47f4bdee316900e3c9`.

Model and application code commitments identify the chosen serving configuration.
They are not independently reproduced hashes of the provider's model weights or
binary image. Provider workload measurements and image provenance are reviewed
separately.

## Remaining acceptance

1. Complete interruption during live settlement and recovery acceptance. A
   restart of a completed request was exercised on the hosted service; rejected,
   cancelled, exact retry and uncertain-execution UI cases passed fixture tests.
   These checks do not establish recovery from an interrupted live settlement.
2. Complete signer rotation and model revocation against the production contracts.
   These scenarios were not performed in the recorded acceptance run. See
   [E1 acceptance](e1-release.md).

Earlier interrupted attempts produced no receipt, execution or USDC debit.
Their expired authorizations, original journals and canonical no-spend evidence
remain retained for reconciliation. The completed payments above use separate
intents and journals.

The selected route remains experimental direct NEAR. Current serving limits
include a 512-token generation cap shared by reasoning and final content,
`NEAR_ENABLE_THINKING=true` and a 180-second inference timeout. Reviewed provider
policy version 5 has SHA-256
`c9d2e1f1ea3f41099803a3d3963e4f8d4ef5616c378cf29e43aa689a6f4f6f76`.
The reviewed provider policy and acceptance expire on **8 October 2026 at 14:29:11 UTC**;
renewal requires a new explicit review. Rejected or unavailable evidence stops
admission rather than selecting an unverified fallback.

See [E1 acceptance](e1-release.md), the
[acceptance operator guide](../_backend/scripts/accept-near-arc.md) and
[operations](near-arc-operations.md) for the checks and recovery rules.
