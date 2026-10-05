# Release progress — 5 October 2026

## Owner-reported paid wallet retest — 5 October 2026

The project owner reports that one **0.10 USDC** request completed successfully:
payment, a correct model answer, a signed receipt and an Arc anchor. The receipt
signature and anchor were independently checked during that retest. The report
does not establish that every website or wallet scenario passes.

Fixes for stale OKX sessions, outdated login messages and browser CI failures
are implemented. Combined local validation passed frontend TypeScript,
**281 unit tests**, **49 default browser scenarios** and **18 checkout fixture
scenarios**: **67 browser scenarios** in total. Browser tests use fixtures and
do not establish live wallet or payment acceptance. No tests were skipped and
the CI workflow was not changed. A GitHub browser rerun, manual old-session
recovery and the remaining E1 operational checks are still pending. No transaction or receipt
identifier was supplied with the successful request report, so it is recorded
separately from the four operator calls and 0.40 USDC of retained transaction
evidence below.

The [GitHub run for commit `abdb239`](https://github.com/nerdenpad/enclave-developer/actions/runs/37227524444)
passed backend checks, frontend typechecking, 275 frontend unit tests and the
build. Its browser job passed 42 scenarios and
failed five: one obsolete status-history assertion and four animation checks
that detected duplicate `site.js` elements. Its three sign-in recovery scenarios
passed. The fixes retain these checks; a successful CI rerun is not yet recorded.

## Operator acceptance — 4 October 2026

The backend runs with `NODE_ENV=production`, reviewed provider policy v6 and its
new accepted NEAR + Arc release manifest. A fresh operator EOA request passed
strict provider verification, a complete answer, **0.10 USDC** settlement, receipt
and confirmed Arc anchor on **4 October 2026**. Production startup independently
verified archived evidence and fresh provider admission. Public HTTPS health at
**10:06:57 UTC** reported `stage: production`, `productionReady: true` and
`providerAdmissionReady: true`.

The approved price is **0.10 USDC per request**. Confirmed acceptance usage is
**four calls and 0.40 USDC**, with one settlement per intent. Completed-result
replay after the actual production API restart returned the same result without
additional payment, usage or execution. Every new request still needs fresh
provider verification; the experimental direct route has no availability guarantee.

The earlier WalletConnect operator browser acceptance and the 3 October OKX
regression remain recorded below. The physical OKX retest on 4 October stopped
at provider admission before settlement. Full E1 launch acceptance remains open;
the morning success is dated evidence, not a guarantee of current provider readiness.

## Provider fleet check — 4 October 2026

Fresh checks through the deployed verifier passed at **18:34:38 UTC** and
**18:44:33 UTC**, with `UpToDate` CPU status, eight verified GPUs and the exact
approved 94-action profile. A separate bounded direct-route collection then
verified **10 of 10** fresh CA/SPKI/nonce-bound reports; its last appraisal
completed at **18:50:56 UTC**. All ten reports matched that same complete profile.
They are ten observations, not ten different configurations or proof of full
fleet coverage.

The installed policy still contains **four distinct approved profiles**, with
schema capacity for 32. The requested minimum of ten is **not achieved**: six
additional eligible profiles have not been found. The local evidence inventory
contains four current approvals, a historical 134-action configuration and an
unapproved 146-action candidate. An authenticated Cloud API discovery GET at
**18:52:47 UTC** returned one advertised 146-action model candidate; discovery
alone does not verify or approve it. Its unresolved runtime/source review
remains required before admission.

Public health at **18:54:50 UTC** reported `stage: production`,
`productionReady: true` and `providerAdmissionReady: true`. The private sampler
passed 11 offline tests, preserves exact whole-profile matching and rejects
duplicate policy entries when counting profiles. Its initial launch from an
inaccessible working directory was excluded from the hardware assessment;
the corrected launch used the same working directory as the API. Private raw
evidence, profile records and status records were retained with checked hashes.
No provider policy, key, accepted release, payment or inference was changed or
submitted during these checks. Physical OKX paid acceptance remains open.

## Stable production mode — 4 October 2026

Deployment stage now follows the configured runtime mode. A deployment running
with `NODE_ENV=production` continues to report `stage: production` after provider
rejection or release-evidence expiry. `productionReady` and
`providerAdmissionReady` remain separate checks. The website displays
**PRODUCTION · PROVIDER UNAVAILABLE** after provider admission fails, or
**PRODUCTION · NOT READY** when another readiness condition fails. New payment
and inference requests remain gated by strict verification.

The compatible frontend was installed before the reporting-only backend change.
Exactly seven frontend sources changed; the deployed dashboard recovery bytes
were retained. Only one backend source changed (`gateway.ts`), with its delta
limited to the stage expression and an explanatory comment. Website and API
services restarted; keys, provider policy, accepted evidence and payment
configuration retained their hashes and permissions.

API TypeScript and 26 readiness/inference tests passed. Frontend TypeScript,
115 unit tests and 25 deployment guards passed; all six intercepted health
browser cases also passed against the deployed output. An isolated boot and
the actual API restart passed accepted-archive, Arc contract and fresh provider
checks. Public HTTPS health at **18:24:32 UTC** reported `stage: production`,
`productionReady: true` and `providerAdmissionReady: true`, with HTTP 200 and
`Cache-Control: no-store`. These checks sent no new payment or inference and do
not close the physical OKX paid acceptance scenario.

The installed NEAR fleet policy accepts four reviewed complete workload
profiles. Admission is not pinned to a node IP or an individual GPU serial;
each node must match a reviewed profile and pass fresh CPU, GPU and connection
binding checks. An unknown workload still requires review and a renewed pinned
policy/evidence package. Hardware validity or a matching model name alone does
not approve a new serving build. The direct route can therefore still reject an
unreviewed member of the provider fleet.

## Physical OKX retest — 4 October 2026

The 19:34–20:06 Moscow test connected OKX and completed free wallet sign-in after
reloading an old tab. A 0.10 USDC authorization was approved in the wallet, but
the settlement request stopped before a debit, inference execution or receipt
was recorded. The dashboard retained the original operation for explicit recovery.

The API journal at **16:57:03.740 UTC** records
`INFERENCE_ATTESTATION_FAILED` / `WORKLOAD_NOT_APPROVED` for
`/v1/x402/settle`. This identifies an unapproved workload profile; it does not
identify which provider node served the attempt. The journal correlation is by
endpoint and test window because that log entry does not include the payment ID.
Provider health changed from production/ready to pilot/not ready after rejection.

Read-only database and Arc checks at **17:30:25 UTC** found payment
`372ae708-014a-46fc-83cd-89d976089d30` still `open`, with no settlement transaction,
stored authorization, inference execution or receipt. UsageMeter returned
`settled=false` at canonical block **24255756**, with **12 successor blocks**.
This establishes the status of this exact payment intent, not arbitrary wallet
transfers. No payment or inference was submitted during these checks.

The test preceded deployment of the sign-in cancellation fix described below.
Physical OKX acceptance on the updated frontend remains open. The stale dashboard
readiness display was corrected and deployed separately later that evening; this
does not resolve provider admission or establish a successful paid wallet journey.

## Dashboard readiness refresh — 4 October 2026

The website now reads current health during workspace refresh. A strict provider
rejection immediately invalidates the old ready display and triggers a health
read. An older response cannot restore readiness after a newer rejection. A
failed health read displays **Status unavailable** and blocks a new request;
wallet login, existing history and the original payment recovery remain intact.
Recovery continues only through an explicit user action, with the original
authorization and request preserved. No payment is retried by status refresh.

The isolated release changed only dashboard code and its checkout fixture, with
182 other files byte-identical to the deployed 184-file baseline. TypeScript,
seven focused browser cases and 24 deployment guards passed. All six new health
cases also passed against the deployed Node output, using intercepted APIs and
an unfunded synthetic wallet. No real payment, provider inference or physical OKX
acceptance was performed during this rollout. Page, asset and HTTP 404 guards passed.

Only the website service restarted. Backend code, keys, provider policy and
checkout configuration were retained. Post-deploy health still reported
`stage: pilot` and `productionReady: false`. At that rollout the stage was
computed from readiness; `NODE_ENV=production` had not changed. The later
[stable-mode correction](#stable-production-mode--4-october-2026) separates the
stage from readiness. Physical-wallet acceptance remains open.

## Wallet sign-in recovery — 4 October 2026

A frontend-only recovery fix was deployed after the report of a hung OKX sign-in
in an old dashboard tab. Pending login is cancelled when the wallet disconnects,
expires or changes; a 60-second limit releases the sign-in button and displays
recovery instructions. Old attempt completion cannot publish a stale login or
unlock a replacement attempt. A late server-issued login is explicitly revoked.

The exact isolated release passed TypeScript, 91 wallet unit tests, three browser
regressions and 27 deployment/preparation guards. All three browser scenarios
also passed against the deployed Node output, using synthetic signatures and
intercepted API responses. No real wallet approval, inference or payment was
submitted during this rollout. A physical OKX retest remains open.

Only the website service restarted. Backend code, provider policy, keys,
contracts and the approved 0.10 USDC tariff were retained. At the frontend rollout,
public health reported `stage: pilot` and `productionReady: false`; the earlier
10:06:57 UTC provider acceptance remains historical evidence. The frontend QA
installation accepted that reported state without changing provider admission
or payment gates. Tabs already running the older code need one reload to load
this fix. See [wallet recovery](wallet-payments.md#sign-in-recovery--4-october-2026).

## Provider admission and paid acceptance — 4 October 2026

The admission fix permits up to **three attestation-only candidate connections**
when the direct verifier rejects an unapproved workload. Each connection uses a
fresh nonce, normal CA/hostname/TLS binding, strict CPU/GPU checks and the same
exact pinned policy bytes. Rejected connections are closed and one original
deadline covers all candidates. Other verification failures are terminal;
inference POSTs are never repeated by this mechanism. Unapproved workloads remain
unapproved and all candidates can still fail admission.

Reviewed provider policy v6 passed a fresh hardware check at **09:26:35 UTC**,
including `UpToDate` CPU status and eight verified GPUs under an exact previously
reviewed complete profile. One operator EOA request then returned final content
exactly `READY` with `finish_reason: stop`; thinking remained enabled and the
generation cap was 512 tokens. Its signed transcript, receipt, **0.10 USDC**
settlement and canonical Arc anchor passed strict acceptance.

| Operation | Confirmed transaction |
| --- | --- |
| Settle v6 acceptance 0.10 USDC | [UsageMeter settlement](https://explorer.arc.io/tx/0xed2f012b67fe7003eea55e9b5486c483f70e122a20ec2cc48f440d675b4831db) |
| Anchor v6 acceptance receipt | [AttestationVerifier anchor](https://explorer.arc.io/tx/0xb4c045581b6a999783140f67ac6320051374c24da3a557433d198ea020d97d39) |

The signed receipt hash is
`0xd02e73d8c7958e1838ca74c9f14b483a78dbdde62c4e2d0f3782bb171245a8f2`.
Provider policy v6 has SHA-256
`75abdd6f7e2a075863b71afa68a7e7dddb43115f3834b6428ace33a228d89ffa`.
The installed accepted manifest has SHA-256
`c796792667d7e269dae9502be220b69c567a5671e2645e9069fd643e505c1da1`.
The review and acceptance expire on **8 October 2026 at 14:29:11 UTC**;
this rollout did not extend that deadline.

The production API restarted at **10:02:37 UTC** and passed archived-evidence,
contract/policy/signer and fresh provider startup checks. An explicit replay
of the original completed request returned the exact same
response, payment, receipt, settlement and anchor. Before/after database and
canonical chain readbacks retained **four calls and 0.40 USDC**, with no new
payment, usage or execution. This post-restart proof is retained separately;
the accepted manifest's original bytes were not rewritten to include it.

This run exercised an operator EOA and the deployed backend. It did not exercise
the physical OKX wallet-app UI. The temporary private acceptance service was
stopped; the public API, website and worker remained active.

## Earlier completed acceptance — 1 October 2026

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
  hardware and fresh provider checks. At that acceptance, the public API reported
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

## Manual wallet regression — 3 October 2026

The project owner confirmed manual wallet acceptance on 3 October 2026. That
earlier confirmation remains part of the acceptance history. Manual acceptance
was subsequently reopened following the detailed OKX failure report for
**2 October 2026, 22:16–22:24 Moscow time**.

In the reported time window, settlement admission rejected provider evidence
with `INFERENCE_ATTESTATION_FAILED` and `WORKLOAD_NOT_APPROVED`. The read-only
application database snapshot showed an open payment, no stored authorization,
no settlement transaction, no execution and no receipt.

The canonical Arc Mainnet (chain **5042**) readback completed on
**3 October 2026 at 17:39:04 UTC**.
At block **24086493**, confirmed with **12 successor blocks**, `UsageMeter.settled`
was `false` for the `keccak256`-derived intent of payment
`a10a8fbc-4db7-434f-8fcd-2f618b14ec07`. This establishes no UsageMeter settlement
for that exact intent at that block; it does not rule out other wallet transfers.
The read-only check sent no payment or inference request.

At the 3 October review, provider policy **version 6 was a candidate and had not
been installed or freshly accepted**. New payment/inference admission was
blocked. Web corrective fixes were deployed that day; a real OKX retest and
current provider workload acceptance were open. Provider v6 paid acceptance and
installation completed separately on 4 October; the physical OKX retest remains
open. The three successful 1 October
acceptance calls and their **0.30 USDC** of confirmed settlements remain recorded
above.

## Web QA rollout — 3 October 2026

Corrective web fixes for HTTP behavior, mobile layout and wallet-session recovery
were deployed on 3 October 2026. This rollout did not restart the API or worker.
The deployed source manifest has SHA-256
`a77a15b8e8be4ea22c33a481a184693e9c51041e4632ec62586ff11f062161fb`;
the installed build output has SHA-256
`8f0d7191087b079ed11d4c10fd6063313a7b1c0146e22a2409c8133e759810cf`.

This web rollout supplied no new paid inference acceptance. At that time, strict
NEAR workload review was open and new payment/inference admission was blocked.
Physical WalletConnect/manual wallet acceptance was reopened; a real OKX retest
is still pending. Confirmed paid acceptance at that review was three calls and
**0.30 USDC**. The separate 4 October backend acceptance is recorded above.

## Backend readiness correction — 3 October 2026

The backend readiness correction was **deployed on 3 October 2026**. The API
restarted successfully and is active with zero automatic restarts; the worker
was not restarted. The installed version 5 provider policy and historical
accepted manifest and evidence remain in place.

The correction reports `providerAdmissionReady: false` and `productionReady: false`
after a known provider verification rejection. A validated historical release can keep
status, wallet sign-in and stored history available when its fresh startup
provider check rejects evidence. Invalid release archives, keys or chain wiring
still fail startup. New payment and inference requests retain all strict
admission checks; no rejected workload becomes approved through this correction.

The public HTTPS check at **18:41:59.944 UTC** returned health HTTP 200 with
`Cache-Control: no-store`, `stage: pilot`, `providerAdmissionReady: false` and
`productionReady: false`. Wallet configuration, home, dashboard, status, verify
and the XML sitemap returned HTTP 200; an unknown route returned HTTP 404.

The deployed gateway source has SHA-256
`7a66ca4b687c020c2819cea1a8c7dc87f889eb55fbd1ed9deb93afbc7f7a46dc`;
the installed backend inventory has SHA-256
`2aa9a3e0717a06a854c4908bd40f74e1a2c02231562bbba167991172005cb90c`.
The full API suite passed **899/899 tests**, and API TypeScript checking passed.
The rollout sent no payment or inference request and supplies no new paid
acceptance. At that review, provider acceptance and the physical OKX retest were
open; confirmed acceptance was **three calls and 0.30 USDC**. The 4 October
provider admission fix and newly accepted release are recorded above.

## Remaining acceptance

1. Retest the physical OKX connection, sign-in and payment journey against the
   deployed web fixes and newly accepted provider v6 release. Manual wallet
   acceptance is open.
2. Complete interruption during live settlement and recovery acceptance. A
   restart of a completed request was exercised on the hosted service; rejected,
   cancelled, exact retry and uncertain-execution UI cases passed fixture tests.
   These checks do not establish recovery from an interrupted live settlement.
3. Complete signer rotation and model revocation against the production contracts.
   These scenarios were not performed in the recorded acceptance run. See
   [E1 acceptance](e1-release.md).

The earlier interrupted operator acceptance attempts recorded on 1 October
produced no receipt, execution or USDC debit.
Their expired authorizations, original journals and canonical no-spend evidence
remain retained for reconciliation. The completed payments above use separate
intents and journals.

The selected route remains experimental direct NEAR. Current serving limits
include a 512-token generation cap shared by reasoning and final content,
`NEAR_ENABLE_THINKING=true` and a 180-second inference timeout. The 1 October
acceptance archive used reviewed provider policy version 5 with SHA-256
`c9d2e1f1ea3f41099803a3d3963e4f8d4ef5616c378cf29e43aa689a6f4f6f76`.
The current version 6 policy and its newly accepted release retain the same
expiry, **8 October 2026 at 14:29:11 UTC**; renewal requires a new explicit
review and acceptance. Rejected or unavailable evidence stops
admission rather than selecting an unverified fallback.

See [E1 acceptance](e1-release.md), the
[acceptance operator guide](../_backend/scripts/accept-near-arc.md) and
[operations](near-arc-operations.md) for the checks and recovery rules.
