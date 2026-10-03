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
    expect(cfg.NEAR_ENDPOINT_PROFILE).toBe("cloud");
    expect(cfg.NEAR_ENABLE_THINKING).toBe(false);
    expect(cfg.INFERENCE_ALLOW_REMOTE).toBe(false);
    expect(cfg.INFERENCE_API_KEY).toBeUndefined();
    expect(cfg.INFERENCE_HEALTH_PATH).toBeUndefined();
    expect(cfg.INFERENCE_TIMEOUT_MS).toBe(30_000);
    expect(cfg.ARC_RPC_MAX_RPS).toBe(20);
  });

  it("defaults to a shared two request budget on nonlocal chains and accepts a bounded override", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://test/db", DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}`, ARC_CHAIN_ID: "5042" }).ARC_RPC_MAX_RPS).toBe(2);
    expect(loadConfig({ DATABASE_URL: "postgres://test/db", ARC_CHAIN_ID: "1337" }).ARC_RPC_MAX_RPS).toBe(20);
    expect(loadConfig({ DATABASE_URL: "postgres://test/db", DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}`, ARC_CHAIN_ID: "5042", ARC_RPC_MAX_RPS: "1" }).ARC_RPC_MAX_RPS).toBe(1);
  });

  it.each(["0", "21", "1.5", "NaN", ""])("rejects an invalid RPC request budget %s", ARC_RPC_MAX_RPS => {
    expect(() => loadConfig({ DATABASE_URL: "postgres://test/db", ARC_RPC_MAX_RPS })).toThrow("Invalid env");
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
    expect(loadConfig({ ...configured, INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1" }).INFERENCE_BASE_URL).toBe("https://cloud-api.near.ai/v1");
  });

  it.each(["true", "false"])("parses explicit NEAR thinking %s without Boolean string coercion", (value) => {
    expect(loadConfig({ ...configured, NEAR_ENABLE_THINKING: value }).NEAR_ENABLE_THINKING).toBe(value === "true");
  });

  it.each(["yes", "1", "0", "TRUE", ""])("rejects invalid NEAR thinking %s", (value) => {
    expect(() => loadConfig({ ...configured, NEAR_ENABLE_THINKING: value })).toThrow("NEAR_ENABLE_THINKING");
  });

  it("requires an explicitly selected local NVIDIA verifier with absolute artifact paths", () => {
    expect(loadConfig({ ...configured, NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: "/reviewed/bin/nvattest",
      NVIDIA_NVAT_LIBRARY: "/reviewed/lib/libnvat.so.1.2.2" })).toMatchObject({ NVIDIA_VERIFIER_MODE: "local" });
    for (const change of [{ NVIDIA_VERIFIER_MODE: "local" }, { NVIDIA_VERIFIER_MODE: "auto" },
      { NVIDIA_NVAT_BINARY: "/unreviewed/nvattest" },
      { NVIDIA_VERIFIER_MODE: "local", NVIDIA_NVAT_BINARY: "relative/nvattest", NVIDIA_NVAT_LIBRARY: "/reviewed/libnvat.so" }]) {
      expect(() => loadConfig({ ...configured, ...change })).toThrow("Invalid env");
    }
    expect(() => loadConfig({ DATABASE_URL: configured.DATABASE_URL, NVIDIA_VERIFIER_MODE: "local",
      NVIDIA_NVAT_BINARY: "/reviewed/bin/nvattest", NVIDIA_NVAT_LIBRARY: "/reviewed/lib/libnvat.so" })).toThrow("verified NEAR");
  });

  it.each([
    { INFERENCE_BASE_URL: "http://test.completions.near.ai/v1" },
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

describe("managed NEAR production profile", () => {
  const settings = {
    DATABASE_URL: "postgres://unit.invalid/db", NODE_ENV: "production", TEE_MODE: "managed-near", INFERENCE_BACKEND: "near-verified",
    INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1", INFERENCE_MODEL: "z-ai/glm-5.3-flash", INFERENCE_API_KEY: "unit-provider-token",
    INFERENCE_ALLOW_REMOTE: "true", NEAR_VERIFIER_PYTHON: "python", NEAR_ATTESTATION_POLICY: "/reviewed/provider-policy.json",
    NEAR_ATTESTATION_POLICY_SHA256: `0x${"ab".repeat(32)}`, PRODUCTION_RELEASE_MANIFEST: "/accepted/release.json",
    ENCLAVE_CVM_PATH: process.platform === "win32" ? "C:\\accepted\\gateway.json" : "/accepted/gateway.json",
    WALLET_AUTH_ORIGIN: "https://enclaveagent.tech", ARC_CHAIN_ID: "5042", ARC_RPC_URL: "https://rpc.mainnet.arc.io",
    PAYMENT_MODE: "authorized", CHAIN_CONFIRMATIONS: "12", USDC_ADDRESS: "0x3600000000000000000000000000000000000000",
    USDC_EIP712_NAME: "USDC", USDC_EIP712_VERSION: "2", SERVING_IMAGE_ID: "reviewed-near-release-v2", TCB_POLICY_VERSION: "2",
    // This deterministic key is used only to exercise configuration parsing, with no RPC calls.
    DEPLOYER_PRIVATE_KEY: `0x${"12".repeat(32)}`,
    ATTESTATION_VERIFIER_ADDRESS: `0x${"21".repeat(20)}`, MODEL_REGISTRY_ADDRESS: `0x${"22".repeat(20)}`,
    USAGE_METER_ADDRESS: `0x${"23".repeat(20)}`, FEE_VAULT_ADDRESS: `0x${"24".repeat(20)}`,
    ENCL_TOKEN_ADDRESS: `0x${"25".repeat(20)}`, INSURANCE_STAKING_ADDRESS: `0x${"26".repeat(20)}`, AGENT_MANDATE_ADDRESS: `0x${"27".repeat(20)}`,
  };
  it("accepts complete configuration while deferring actual release/evidence acceptance to boot", () => {
    expect(loadConfig(settings)).toMatchObject({ NODE_ENV: "production", TEE_MODE: "managed-near", PAYMENT_MODE: "authorized", ARC_CHAIN_ID: 5042 });
  });
  it.each([
    { TEE_MODE: "dev" }, { INFERENCE_BACKEND: "echo" }, { INFERENCE_BACKEND: "openai-compatible" },
    { INFERENCE_BASE_URL: "https://test.completions.near.ai/v1" }, { ARC_CHAIN_ID: "5042002" }, { PAYMENT_MODE: "mock" },
    { WALLET_AUTH_ORIGIN: undefined }, { PRODUCTION_RELEASE_MANIFEST: undefined }, { NEAR_ATTESTATION_POLICY_SHA256: undefined },
    { ENCLAVE_CVM_PATH: undefined }, { ENCLAVE_CVM_PATH: "relative.json" }, { CHAIN_CONFIRMATIONS: undefined }, { CHAIN_CONFIRMATIONS: "0" },
    { USDC_EIP712_NAME: "USD Coin" }, { USDC_EIP712_VERSION: "1" }, { ARC_RPC_URL: "http://rpc.mainnet.arc.io" },
    { MODEL_REGISTRY_ADDRESS: "0x0000000000000000000000000000000000000007" }, { INFERENCE_MODEL: "echo" },
    { SERVING_IMAGE_ID: "enclave-echo-v1" }, { ALLOW_LOCAL_BOOTSTRAP: "true" },
  ])("rejects incomplete or downgraded production settings %#", (change) => {
    expect(() => loadConfig({ ...settings, ...change })).toThrow();
  });
  it("supports managed pilot sessions but never allows an unverified fallback", () => {
    expect(loadConfig({ ...settings, NODE_ENV: "development" }).TEE_MODE).toBe("managed-near");
    expect(() => loadConfig({ ...settings, NODE_ENV: "development", INFERENCE_BACKEND: "echo" })).toThrow("without a fallback");
  });
  it("accepts a verified experimental direct production endpoint only with its explicit profile", () => {
    const direct = { ...settings, NEAR_ENDPOINT_PROFILE: "direct-experimental", INFERENCE_BASE_URL: "https://test.completions.near.ai/v1" };
    expect(loadConfig(direct)).toMatchObject({ NODE_ENV: "production", TEE_MODE: "managed-near", NEAR_ENDPOINT_PROFILE: "direct-experimental",
      INFERENCE_BACKEND: "near-verified", INFERENCE_BASE_URL: direct.INFERENCE_BASE_URL, PAYMENT_MODE: "authorized" });
    expect(() => loadConfig({ ...direct, NEAR_ENDPOINT_PROFILE: undefined })).toThrow("explicit NEAR profile");
    expect(() => loadConfig({ ...direct, NEAR_ENDPOINT_PROFILE: "cloud" })).toThrow("explicit NEAR profile");
  });
  it.each([
    { INFERENCE_BASE_URL: "https://cloud-api.near.ai/v1" }, { INFERENCE_BASE_URL: "https://other.example/v1" },
    { INFERENCE_BASE_URL: "https://test.completions.near.ai.evil.example/v1" }, { INFERENCE_BASE_URL: "http://test.completions.near.ai/v1" },
    { INFERENCE_BASE_URL: "https://test.completions.near.ai/v1/" }, { INFERENCE_BASE_URL: "https://test.completions.near.ai" },
    { INFERENCE_BASE_URL: "https://test.completions.near.ai:8443/v1" }, { INFERENCE_BASE_URL: "https://test.completions.near.ai/v1?token=ignored" },
    { INFERENCE_BACKEND: "echo" }, { TEE_MODE: "dev" }, { NEAR_ENDPOINT_PROFILE: "direct" },
    { NEAR_ATTESTATION_POLICY_SHA256: undefined }, { PRODUCTION_RELEASE_MANIFEST: undefined }, { NEAR_VERIFIER_PYTHON: undefined },
    { NEAR_ATTESTATION_POLICY: undefined }, { PAYMENT_MODE: "mock" }, { ALLOW_LOCAL_BOOTSTRAP: "true" }, { INFERENCE_ALLOW_REMOTE: "false" },
  ])("rejects an unsafe or incomplete experimental direct production profile %#", (change) => {
    expect(() => loadConfig({ ...settings, NEAR_ENDPOINT_PROFILE: "direct-experimental", INFERENCE_BASE_URL: "https://test.completions.near.ai/v1", ...change })).toThrow();
  });
});
