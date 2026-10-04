import { canSettleLocally, type Health } from "./api";

/** Labels describe reported settings; neither readiness nor a configured price proves checkout acceptance. */
export function deploymentCopy(health: Health | null, arcPaymentsConfigured: boolean) {
  if (!health) return { badgeStage: "STATUS UNAVAILABLE", stage: "Deployment status unavailable", network: "Network not reported",
    summary: "Deployment status unavailable · Public checkout blocked", homeDetails: "Deployment status is unavailable. Public checkout is blocked until this site's payment configuration is reviewed.",
    paymentDescription: "Deployment status is unavailable. Public checkout is blocked.", checkout: "Public checkout blocked", settling: "Settling payment" };
  const production = health.deployment?.stage === "production";
  const providerUnavailable = production && health.deployment?.providerAdmissionReady === false;
  const reportedReady = production && health.deployment?.productionReady === true && !providerUnavailable;
  const stage = production ? reportedReady ? "Production · reported ready"
    : providerUnavailable ? "Production · provider unavailable" : "Production · not ready"
    : health.deployment?.stage === "pilot" ? "Pilot · production not ready"
      : health.deployment?.stage === "development" ? "Development · production not ready" : "Release status not reported";
  const badgeStage = production ? reportedReady ? "PRODUCTION (REPORTED)"
    : providerUnavailable ? "PRODUCTION · PROVIDER UNAVAILABLE" : "PRODUCTION · NOT READY"
    : health.deployment?.stage?.toUpperCase() ?? "RELEASE NOT REPORTED";
  const network = health.chainId === 5042 ? "Arc (chain 5042)"
    : [31337, 1337].includes(health.chainId) ? `Local EVM (chain ${health.chainId})` : `EVM chain ${health.chainId}`;
  const local = canSettleLocally(health);
  const arcEnabled = arcPaymentsConfigured && health.chainId === 5042 && health.paymentMode === "authorized";
  const payment = health.paymentMode === "mock" ? "Mock settlement · test funds" : "Authorized USDC settlement";
  const checkout = arcEnabled ? "Browser Arc payments configured" : "Public checkout blocked";
  const paymentDescription = local ? "Local settlement uses test USDC. Remote provider usage can still be billed."
    : health.paymentMode === "mock" ? "Mock settlement uses test funds. Public checkout is blocked for real USDC."
      : arcEnabled ? "Real USDC payments on Arc require your explicit wallet approval. Failed inference does not automatically refund a settled payment."
        : `Authorized settlement is configured on ${network}. Public checkout is blocked until this site has reviewed and enabled its Arc payment configuration.`;
  const provider = health.inferenceBackend === "near-verified" ? "The gateway checks remote CPU/GPU evidence before provider requests."
    : health.inferenceBackend === "echo" ? "The echo provider is a development fixture." : "This provider adapter does not verify remote hardware.";
  return { badgeStage, stage, network, checkout, paymentDescription,
    summary: `${stage} · ${network} · ${payment} · ${checkout}`,
    homeDetails: `${stage}. ${paymentDescription} ${provider} These gateway settings do not independently prove a completed request or payment.`,
    settling: local ? "Settling test USDC" : health.chainId === 5042 && health.paymentMode === "authorized" ? "Settling Arc USDC" : "Settling USDC" };
}
