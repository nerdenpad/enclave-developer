import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

it.each(["0.0000001", "100000000000"])("rejects unrepresentable payment price %s before startup", (price) => {
  expect(() => loadConfig({ DATABASE_URL: "postgres://test/db", INFERENCE_PRICE_USDC: price })).toThrow("Price must be at least one USDC unit");
});

describe("loadConfig", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadConfig({ NODE_ENV: "test" })).toThrow(/Invalid env/);
  });

  it("parses defaults", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://enclave:enclave@127.0.0.1:5433/enclave" });
    expect(cfg.API_PORT).toBe(8787);
    expect(cfg.TEE_MODE).toBe("dev");
    expect(cfg.INFERENCE_ALLOW_REMOTE).toBe(false);
    expect(cfg.INFERENCE_API_KEY).toBeUndefined();
    expect(cfg.INFERENCE_HEALTH_PATH).toBeUndefined();
    expect(cfg.INFERENCE_TIMEOUT_MS).toBe(30_000);
  });

  it("fails closed instead of starting a software CVM in production", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", NODE_ENV: "production" })).toThrow(/hardware TEE/);
  });

  it("enables a local OpenAI-compatible backend only when explicitly configured", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://test" }).INFERENCE_BACKEND).toBe("echo");
    const configured = loadConfig({ DATABASE_URL: "postgres://test", INFERENCE_BACKEND: "openai-compatible", INFERENCE_BASE_URL: "http://127.0.0.1:8000/v1", INFERENCE_MODEL: "local-cpu-model", INFERENCE_TIMEOUT_MS: "5000" });
    expect(configured.INFERENCE_BACKEND).toBe("openai-compatible");
    expect(configured.INFERENCE_MODEL).toBe("local-cpu-model");
    expect(configured.INFERENCE_TIMEOUT_MS).toBe(5000);
    expect(configured.PAYMENT_MODE).toBe("mock");
  });

  it.each([
    { INFERENCE_BACKEND: "arbitrary" }, { INFERENCE_BASE_URL: "not-url" }, { INFERENCE_MODEL: "" },
    { INFERENCE_TIMEOUT_MS: "0" }, { INFERENCE_TIMEOUT_MS: "300001" }, { PAYMENT_MODE: "unverified" },
  ])("rejects invalid inference or payment configuration %#", (settings) => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", ...settings })).toThrow(/Invalid env/);
  });

  it("accepts authenticated HTTPS inference only with explicit remote opt-in", () => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://test", INFERENCE_BACKEND: "openai-compatible",
      INFERENCE_BASE_URL: "https://gpu.example.modal.run/v1", INFERENCE_ALLOW_REMOTE: "true",
      INFERENCE_API_KEY: "modal-secret", INFERENCE_MODEL: "gpu-model", INFERENCE_TIMEOUT_MS: "300000", INFERENCE_HEALTH_PATH: "/health" });
    expect(cfg).toMatchObject({ INFERENCE_ALLOW_REMOTE: true, INFERENCE_API_KEY: "modal-secret", INFERENCE_TIMEOUT_MS: 300_000, INFERENCE_HEALTH_PATH: "/health", TEE_MODE: "dev" });
  });

  it.each([
    { INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_API_KEY: "secret" },
    { INFERENCE_BASE_URL: "http://gpu.example/v1", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: "secret" },
    { INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_ALLOW_REMOTE: "true" },
    { INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: " " },
    { INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_ALLOW_REMOTE: "yes", INFERENCE_API_KEY: "secret" },
  ])("rejects unsafe or unauthorized remote inference configuration %#", (settings) => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", INFERENCE_BACKEND: "openai-compatible", ...settings })).toThrow(/Invalid env/);
  });

  it.each(["http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])("keeps unauthenticated loopback HTTP working at %s", (url) => {
    const cfg = loadConfig({ DATABASE_URL: "postgres://test", INFERENCE_BACKEND: "openai-compatible", INFERENCE_BASE_URL: url, INFERENCE_API_KEY: "" });
    expect(cfg.INFERENCE_ALLOW_REMOTE).toBe(false);
  });

  it("does not include a credential in configuration validation errors", () => {
    const secret = "modal-secret\nInjected: secret";
    try {
      loadConfig({ DATABASE_URL: "postgres://test", INFERENCE_BACKEND: "openai-compatible", INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: secret });
      expect.fail("Invalid credential was accepted");
    } catch (error) {
      expect(String(error)).toContain("Invalid inference API key");
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain("modal-secret");
    }
  });

  it("keeps the production hardware-TEE requirement for authenticated remote inference", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", NODE_ENV: "production", INFERENCE_BACKEND: "openai-compatible",
      INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: "secret" })).toThrow(/hardware TEE/);
  });

  it.each(["https://other.example/health", "//other.example/health", "/health?key=value", "health"])("rejects a health endpoint outside the configured HTTPS path boundary %#", (healthPath) => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", INFERENCE_BACKEND: "openai-compatible", INFERENCE_BASE_URL: "https://gpu.example/v1",
      INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: "secret", INFERENCE_HEALTH_PATH: healthPath })).toThrow(/health path/);
  });

  it("fails closed when authorized payments would otherwise use simulated addresses", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", PAYMENT_MODE: "authorized" })).toThrow(/configured token and usage meter/);
    const valid = {
      DATABASE_URL: "postgres://test", PAYMENT_MODE: "authorized",
      USDC_ADDRESS: "0x0000000000000000000000000000000000000100",
      USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000200",
    };
    expect(loadConfig(valid).PAYMENT_MODE).toBe("authorized");
    expect(() => loadConfig({ ...valid, USDC_ADDRESS: "0x0000000000000000000000000000000000000003" })).toThrow(/USDC_ADDRESS/);
    expect(() => loadConfig({ ...valid, USAGE_METER_ADDRESS: "not-an-address" })).toThrow(/USAGE_METER_ADDRESS/);
  });

  it("defaults local bootstrap off and prevents enabling it on an external chain", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://test" }).ALLOW_LOCAL_BOOTSTRAP).toBe(false);
    expect(loadConfig({ DATABASE_URL: "postgres://test", ALLOW_LOCAL_BOOTSTRAP: "true", ARC_CHAIN_ID: "31337" }).ALLOW_LOCAL_BOOTSTRAP).toBe(true);
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", ALLOW_LOCAL_BOOTSTRAP: "true", ARC_CHAIN_ID: "5042002" })).toThrow(/local chains/);
  });

  it.each(["TEE_MODE", "NODE_ENV", "DEPLOYER_PRIVATE_KEY", "ARC_CHAIN_ID", "TCB_POLICY_VERSION", "INFERENCE_PRICE_USDC"])("rejects invalid %s", (field) => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test", [field]: "invalid" })).toThrow(/Invalid env/);
  });
});

describe("verified NEAR configuration", () => {
  const configured = { DATABASE_URL: "postgres://unit.invalid/db", NODE_ENV: "test", INFERENCE_BACKEND: "near-verified",
    INFERENCE_BASE_URL: "https://test.completions.near.ai/v1", INFERENCE_MODEL: "Qwen/Test", INFERENCE_API_KEY: "unit-near-secret",
    INFERENCE_ALLOW_REMOTE: "true", NEAR_VERIFIER_PYTHON: "python", NEAR_ATTESTATION_POLICY: "/fixture/policy.json" };

  it("accepts an explicit direct provider with a verifier policy and conservative token default", () => {
    expect(loadConfig(configured)).toMatchObject({ INFERENCE_BACKEND: "near-verified", TEE_MODE: "dev", NEAR_MAX_TOKENS: 512,
      NEAR_VERIFIER_PYTHON: "python", NEAR_ATTESTATION_POLICY: "/fixture/policy.json" });
    expect(loadConfig({ ...configured, NEAR_MAX_TOKENS: "64", INFERENCE_HEALTH_PATH: "" }).NEAR_MAX_TOKENS).toBe(64);
  });

  it.each([
    { INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1" }, { INFERENCE_BASE_URL: "http://test.completions.near.ai/v1" },
    { INFERENCE_BASE_URL: "https://test.completions.near.ai.attacker.example/v1" }, { INFERENCE_BASE_URL: "https://test.completions.near.ai/v1?secret=bad" },
    { INFERENCE_ALLOW_REMOTE: "false" }, { INFERENCE_API_KEY: undefined }, { INFERENCE_API_KEY: " " },
    { NEAR_VERIFIER_PYTHON: undefined }, { NEAR_ATTESTATION_POLICY: undefined }, { INFERENCE_HEALTH_PATH: "/health" },
    { NEAR_MAX_TOKENS: "0" }, { NEAR_MAX_TOKENS: "4097" }, { NEAR_MAX_TOKENS: "1.5" },
  ])("refuses unsafe or incomplete provider configuration %#", (change) => {
    expect(() => loadConfig({ ...configured, ...change })).toThrow("Invalid env");
  });

  it("never upgrades the local development gateway into production hardware mode", () => {
    expect(() => loadConfig({ ...configured, NODE_ENV: "production" })).toThrow("hardware TEE");
    expect(() => loadConfig({ ...configured, TEE_MODE: "near" })).toThrow("Invalid env");
  });

  it("redacts invalid NEAR credentials from startup errors", () => {
    const token = "private-near-secret\r\nBad: value";
    try { loadConfig({ ...configured, INFERENCE_API_KEY: token }); expect.fail("accepted unsafe key"); }
    catch (error) { expect(String(error)).toContain("NEAR API key is required"); expect(String(error)).not.toContain("private-near-secret"); }
  });
});

describe("agent runtime opt-in", () => {
  const base = { DATABASE_URL: "postgres://unit.invalid/db" };
  it("keeps autonomous calls disabled by default and sets finite limits", () => {
    expect(loadConfig(base)).toMatchObject({ AGENT_RUNTIME_ENABLED: false, AGENT_RUNTIME_MAX_STEPS: 8,
      AGENT_RUNTIME_MAX_BUDGET_UNITS: 1_000_000, AGENT_RUNTIME_MAX_DURATION_MS: 900_000 });
  });
  it.each([
    { ARC_CHAIN_ID: "31337", ALLOW_LOCAL_BOOTSTRAP: "false" },
    { ARC_CHAIN_ID: "1337", ALLOW_LOCAL_BOOTSTRAP: "true" },
    { ARC_CHAIN_ID: "5042002", ALLOW_LOCAL_BOOTSTRAP: "false" },
  ])("refuses unattended mock payments outside explicit local fixtures %#", (change) => {
    expect(() => loadConfig({ ...base, AGENT_RUNTIME_ENABLED: "true", ...change })).toThrow("Agent mock payments require explicit bootstrap");
  });
  it("enables mock jobs only for explicitly opted-in local fixtures", () => {
    expect(loadConfig({ ...base, AGENT_RUNTIME_ENABLED: "true", ALLOW_LOCAL_BOOTSTRAP: "true" }).AGENT_RUNTIME_ENABLED).toBe(true);
  });
  it("allows authorized jobs with real configured payment addresses", () => {
    expect(loadConfig({ ...base, AGENT_RUNTIME_ENABLED: "true", PAYMENT_MODE: "authorized", ARC_CHAIN_ID: "5042002",
      USDC_ADDRESS: "0x0000000000000000000000000000000000000100",
      USAGE_METER_ADDRESS: "0x0000000000000000000000000000000000000200" }).AGENT_RUNTIME_ENABLED).toBe(true);
  });
  it.each([
    { AGENT_RUNTIME_ENABLED: "yes" }, { AGENT_RUNTIME_POLL_MS: "0" }, { AGENT_RUNTIME_POLL_MS: "60001" },
    { AGENT_RUNTIME_MAX_STEPS: "0" }, { AGENT_RUNTIME_MAX_STEPS: "101" },
    { AGENT_RUNTIME_MAX_BUDGET_UNITS: "0" }, { AGENT_RUNTIME_MAX_BUDGET_UNITS: "1000000000001" },
    { AGENT_RUNTIME_MAX_DURATION_MS: "999" }, { AGENT_RUNTIME_MAX_DURATION_MS: "86400001" },
  ])("rejects unsafe job limits %#", (change) => {
    expect(() => loadConfig({ ...base, ...change })).toThrow("Invalid env");
  });
});
