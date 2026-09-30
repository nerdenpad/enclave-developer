import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthSchema, type Health, type Policies } from "./api";
import { DeploymentStatusContent } from "./DeploymentStatusPage";

const hash = `0x${"ab".repeat(32)}`;
const address = `0x${"12".repeat(20)}` as const;
const development: Health = {
  ok: true, service: "enclave-gateway", teeMode: "dev", inferenceBackend: "echo", chainId: 31337,
  paymentMode: "mock", servingModel: { id: "echo", name: "Echo", modelHash: hash as `0x${string}`, codeHash: hash as `0x${string}` },
  receiptSigner: address, verifierAddress: address, agentRuntimeEnabled: false, inferencePriceUsdc: 0.001,
};
const production: Health = {
  ...development, teeMode: "managed-near", inferenceBackend: "near-verified", chainId: 5042, paymentMode: "authorized",
  deployment: { stage: "production", productionReady: true, gatewayKeyCustody: "software", inferenceTrust: "near-cpu-gpu", releaseProfile: "near-arc" },
  providerPolicy: { sha256: hash, expiresAt: "2099-01-01T00:00:00Z" },
};
const policies: Policies = {
  active: { version: 1, servingImageId: "gateway", measurement: hash as `0x${string}`, policyHash: hash as `0x${string}`,
    status: "active", binding: "onchain", scope: "arc", trustMode: "development-software", activatedAt: null, createdAt: "2026-09-30T00:00:00Z" },
  history: [],
};
function render(health: Health | null, paymentsConfigured = false, error = "") {
  return renderToStaticMarkup(createElement(DeploymentStatusContent, {
    snapshot: health ? { health, policies, at: "2026-09-30T00:00:00Z" } : null,
    error, receiptCount: null, arcPaymentsConfigured: paymentsConfigured, refreshStatus: () => {},
  }));
}

describe("deployment health contract", () => {
  it("retains legacy health responses and optional deployment fields", () => {
    expect(HealthSchema.safeParse(development).success).toBe(true);
    expect(HealthSchema.safeParse({ ...development, deployment: { stage: "development", productionReady: false, gatewayKeyCustody: "software" } }).success).toBe(true);
  });
  it("accepts managed pilot and complete reported production status", () => {
    expect(HealthSchema.safeParse({ ...production, deployment: { ...production.deployment, stage: "pilot", productionReady: false } }).success).toBe(true);
    expect(HealthSchema.safeParse(production).success).toBe(true);
  });
  it.each(["near-direct-experimental", "near-cloud-gateway"])("accepts reported verified route %s without requiring it in legacy health", inferenceRoute => {
    expect(HealthSchema.safeParse({ ...production, inferenceRoute }).success).toBe(true);
  });
  it.each([
    { label: "pilot ready claim", patch: { deployment: { ...production.deployment, stage: "pilot" } } },
    { label: "production not ready", patch: { deployment: { ...production.deployment, productionReady: false } } },
    { label: "missing release profile", patch: { deployment: { ...production.deployment, releaseProfile: undefined } } },
    { label: "development release profile", patch: { deployment: { ...production.deployment, releaseProfile: "development" } } },
    { label: "missing CPU/GPU trust", patch: { deployment: { ...production.deployment, inferenceTrust: undefined } } },
    { label: "development gateway", patch: { teeMode: "dev" } },
    { label: "unverified inference", patch: { inferenceBackend: "echo" } },
    { label: "local network", patch: { chainId: 31337 } },
    { label: "mock payments", patch: { paymentMode: "mock" } },
    { label: "missing provider policy", patch: { providerPolicy: undefined } },
    { label: "development inference route", patch: { inferenceRoute: "development" } },
    { label: "hardware gateway key claim", patch: { deployment: { ...production.deployment, gatewayKeyCustody: "hardware" } } },
  ])("rejects an inconsistent production claim: $label", ({ patch }) => {
    expect(HealthSchema.safeParse({ ...production, ...patch }).success).toBe(false);
  });
  it.each([
    { sha256: "ab", expiresAt: "2099-01-01T00:00:00Z" },
    { sha256: `0x${"AB".repeat(32)}`, expiresAt: "2099-01-01T00:00:00Z" },
    { sha256: hash, expiresAt: "never" },
  ])("rejects malformed provider policy metadata", providerPolicy => {
    expect(HealthSchema.safeParse({ ...production, providerPolicy }).success).toBe(false);
  });
  it("rejects an unrecognized inference route", () => {
    expect(HealthSchema.safeParse({ ...development, inferenceRoute: "direct" }).success).toBe(false);
  });
});

describe("reported deployment status", () => {
  it("shows a managed pilot with software admission and conditional payment limits", () => {
    const html = render({ ...production, deployment: { ...production.deployment!, stage: "pilot", productionReady: false } });
    expect(html).toContain("PILOT · PRODUCTION NOT READY");
    expect(html).toContain("This is a pilot deployment");
    expect(html).toContain("Arc · chain 5042");
    expect(html).toContain("Software-managed keys");
    expect(html).toContain("Gateway sessions provide software admission");
    expect(html).toContain("checks remote CPU and GPU evidence");
    expect(html).toContain(hash);
    expect(html).toContain("2099-01-01T00:00:00Z");
    expect(html).toContain("Browser Arc payments are not enabled for this site");
    expect(html).not.toContain("Mock settlement uses test funds");
    expect(html).not.toContain("Production mode remains blocked");
  });
  it("labels production as reported and keeps receipt and local key trust separate", () => {
    const html = render(production, true);
    expect(html).toContain("PRODUCTION · REPORTED READY");
    expect(html).toContain("does not independently verify the accepted release");
    expect(html).toContain("release readiness does not imply hardware custody of local keys");
    expect(html).toContain("Browser Arc payments are enabled");
    expect(html).toContain("requires your explicit wallet approval");
    expect(html).toContain("A receipt signature does not by itself prove hardware attestation");
    expect(html).not.toContain("This is a pilot deployment");
    expect(html).not.toContain("No live or production status has been established");
  });
  it("does not infer a release stage from legacy health or paid settlement from mock mode", () => {
    const html = render(development, true);
    expect(html).toContain("RELEASE STATUS NOT REPORTED");
    expect(html).toContain("Mock settlement uses test funds");
    expect(html).toContain("Browser Arc payments are not enabled");
    expect(html).not.toContain("checks remote CPU and GPU evidence");
    expect(html).not.toContain("PRODUCTION · REPORTED READY");
  });
  it("shows the experimental direct route without inferring production readiness", () => {
    const html = render({ ...production, inferenceRoute: "near-direct-experimental", deployment: { ...production.deployment!, stage: "pilot", productionReady: false } });
    expect(html).toContain("Inference route");
    expect(html).toContain("Experimental direct NEAR");
    expect(html).toContain("PILOT · PRODUCTION NOT READY");
    expect(html).not.toContain("NEAR Cloud Gateway");
    expect(html).not.toContain("PRODUCTION · REPORTED READY");
  });
  it("distinguishes the cloud route and retains reported readiness semantics for accepted direct releases", () => {
    expect(render({ ...production, inferenceRoute: "near-cloud-gateway" })).toContain("NEAR Cloud Gateway");
    const direct = render({ ...production, inferenceRoute: "near-direct-experimental" });
    expect(direct).toContain("PRODUCTION · REPORTED READY");
    expect(direct).toContain("Experimental direct NEAR");
    expect(direct).toContain("does not independently verify the accepted release");
  });
  it("shows unavailable status without a production claim", () => {
    const html = render(null, true, "Deployment details are unavailable or inconsistent. No live or production status has been established.");
    expect(html).toContain("STATUS UNAVAILABLE");
    expect(html).toContain("No live or production status has been established");
    expect(html.match(/No live or production status has been established/g)).toHaveLength(1);
    expect(html).not.toContain("PRODUCTION · REPORTED READY");
    expect(html).not.toContain("Browser Arc payments are enabled");
  });
});
