import { describe, expect, it } from "vitest";
import { HealthSchema } from "./api";
import { deploymentCopy } from "./deployment-copy";

const health = (changes = {}) => HealthSchema.parse({ ok: true, service: "gateway", teeMode: "dev", inferenceBackend: "near-verified",
  chainId: 31337, paymentMode: "mock", servingModel: { id: "glm", name: "GLM", modelHash: `0x${"12".repeat(32)}`, codeHash: `0x${"13".repeat(32)}` },
  receiptSigner: `0x${"14".repeat(20)}`, verifierAddress: `0x${"15".repeat(20)}`, agentRuntimeEnabled: false, inferencePriceUsdc: 0.1, ...changes });
const managed = (ready = false) => health({ teeMode: "managed-near", chainId: 5042, paymentMode: "authorized", inferenceRoute: "near-direct-experimental",
  deployment: { stage: ready ? "production" : "pilot", productionReady: ready, gatewayKeyCustody: "software", inferenceTrust: "near-cpu-gpu", releaseProfile: "near-arc" },
  providerPolicy: { sha256: `0x${"16".repeat(32)}`, expiresAt: "2026-10-10T00:00:00Z" } });

describe("copy derived from gateway settings and browser payment configuration", () => {
  it("keeps unavailable status and checkout blocked even if the site has payment pins", () => {
    const copy = deploymentCopy(null, true);
    expect(copy.summary).toBe("Deployment status unavailable · Public checkout blocked");
    expect(copy.homeDetails).not.toMatch(/ready|test funds|Anvil|Arc settlement/i);
  });
  it("does not invent a release stage for older health responses", () => {
    const copy = deploymentCopy(health(), false);
    expect(copy.stage).toBe("Release status not reported");
    expect(copy.summary).toContain("Local EVM (chain 31337)");
    expect(copy.paymentDescription).toContain("test USDC");
    expect(copy.settling).toBe("Settling test USDC");
  });
  it("shows Arc pilot and authorized settlement without falsely opening browser checkout", () => {
    const copy = deploymentCopy(managed(), false);
    expect(copy.badgeStage).toBe("PILOT");
    expect(copy.stage).toBe("Pilot · production not ready");
    expect(copy.network).toBe("Arc (chain 5042)");
    expect(copy.paymentDescription).toContain("Authorized settlement is configured");
    expect(copy.checkout).toBe("Public checkout blocked");
    expect(copy.settling).toBe("Settling Arc USDC");
    expect(copy.homeDetails).not.toMatch(/MockUSDC|Anvil|development gateway/i);
  });
  it("keeps public checkout blocked even when the gateway reports a production release", () => {
    const copy = deploymentCopy(managed(true), false);
    expect(copy.stage).toBe("Production · reported ready");
    expect(copy.summary).toContain("Public checkout blocked");
    expect(copy.homeDetails).toContain("do not independently prove");
  });
  it("keeps production visible when strict provider admission is unavailable", () => {
    const h = managed(true);
    h.deployment = { ...h.deployment!, productionReady: false, providerAdmissionReady: false };
    const copy = deploymentCopy(h, true);
    expect(copy.badgeStage).toBe("PRODUCTION · PROVIDER UNAVAILABLE");
    expect(copy.stage).toBe("Production · provider unavailable");
    expect(copy.summary).not.toMatch(/Pilot|reported ready/);
    expect(copy.checkout).toBe("Browser Arc payments configured");
    expect(copy.paymentDescription).toContain("explicit wallet approval");
  });
  it.each([true, undefined])("labels other production readiness failures without inventing provider unavailability (%s)", providerAdmissionReady => {
    const h = managed(true);
    h.deployment = { ...h.deployment!, productionReady: false, providerAdmissionReady };
    const copy = deploymentCopy(h, true);
    expect(copy.badgeStage).toBe("PRODUCTION · NOT READY");
    expect(copy.stage).toBe("Production · not ready");
    expect(copy.summary).not.toMatch(/Pilot|reported ready|provider unavailable/);
  });
  it("does not label inconsistent provider admission as ready", () => {
    const h = managed(true);
    h.deployment = { ...h.deployment!, providerAdmissionReady: false };
    expect(deploymentCopy(h, true).badgeStage).toBe("PRODUCTION · PROVIDER UNAVAILABLE");
    expect(deploymentCopy(h, true).summary).not.toContain("reported ready");
  });
  it("only describes real Arc payments when the explicit site configuration also permits them", () => {
    const copy = deploymentCopy(managed(true), true);
    expect(copy.checkout).toBe("Browser Arc payments configured");
    expect(copy.paymentDescription).toContain("explicit wallet approval");
    expect(copy.paymentDescription).toContain("does not automatically refund");
    expect(copy.settling).not.toContain("test");
  });
  it("does not infer Arc checkout from a flag on another chain or a mock gateway", () => {
    for (const h of [health({ chainId: 8453, paymentMode: "authorized" }), health({ chainId: 5042 })]) {
      expect(deploymentCopy(h, true).checkout).toBe("Public checkout blocked");
    }
  });
  it("labels development from the reported stage and keeps provider verification boundaries", () => {
    const h = health({ inferenceBackend: "openai-compatible", deployment: { stage: "development", productionReady: false, gatewayKeyCustody: "software" } });
    const copy = deploymentCopy(h, false);
    expect(copy.badgeStage).toBe("DEVELOPMENT");
    expect(copy.homeDetails).toContain("does not verify remote hardware");
  });
});
