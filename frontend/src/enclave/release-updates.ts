// Public status history records reviewed repository and deployment updates. Add entries only for shipped changes.
export const releaseUpdates = [
  { date: "2026-10-03", title: "Wallet recovery and mobile layout fixes", detail: "Wallet approvals now check the current session, account and permissions. A lost connection preserves the original request for explicit same-wallet recovery; identity changes clear the workspace. The mobile Foundation heading wraps within its column, unknown pages return HTTP 404, and a canonical XML sitemap is available. Manual OKX checkout acceptance and the current provider-policy review remain open.", revision: "Deployment record" },
  { date: "2026-10-01", title: "Browser wallet acceptance and animation recovery", detail: "A real WalletConnect session signed in, survived home navigation and reload, and approved one 0.10 USDC payment. The NEAR response and receipt signature were verified in the browser; JSON and CSV exports passed. The receipt's Arc anchor and policy were independently confirmed. Desktop and mobile animation checks passed after publishing the missing build assets. A separate manual phone-wallet check remains open.", revision: "Deployment record", links: [
    { label: "Browser payment", url: "https://explorer.arc.io/tx/0xac695390ce47c64ceab1181452689441d6b2ba50c2beaabea32261c6f884ebde" },
    { label: "Browser receipt anchor", url: "https://explorer.arc.io/tx/0x5e62b9500706aca5547380aa20d80a5e2400b79b83f5cf1164ccd6b14e599675" },
  ] },
  { date: "2026-10-01", title: "Hosted production checks and restart replay", detail: "The backend passed its managed NEAR and Arc production release checks. An operator acceptance request verified the signed NEAR transcript, CPU evidence and eight GPUs, paid 0.10 USDC and anchored its receipt on Arc. After the API and worker restarted, the same stored output, proof and receipt were recovered with one settlement and one usage record. The commercial price is approved at 0.10 USDC per request. Remaining release scenarios are recorded in the acceptance checklist.", revision: "Deployment record", links: [
    { label: "Acceptance payment", url: "https://explorer.arc.io/tx/0xaf1de665791e94a8f87f74e00edfdbf7f1cd56f8ec32bf98e0a57c36cbc73f33" },
    { label: "Receipt anchor", url: "https://explorer.arc.io/tx/0xeefdee7f01fd42a28546db8de2d0052f4b6a7711dd03684b6063b2b30ff33e5a" },
  ] },
  { date: "2026-10-01", title: "Arc policy and hardware verifier deployed", detail: "Arc serving policy version 2 is listed, approved and activated. Strict verification with the pinned local NVIDIA SDK is deployed.", revision: "Deployment record" },
  { date: "2026-09-28", title: "Roadmap refreshed", detail: "Published the current release plan and acceptance criteria.", revision: "b2f090d" },
  { date: "2026-09-26", title: "Arc deployment configuration", detail: "Added Arc Mainnet settlement deployment while keeping public checkout disabled.", revision: "471b90f" },
  { date: "2026-09-25", title: "Development walkthrough", detail: "Added a local simulation walkthrough for technical review.", revision: "2a213ef" },
] as const;
