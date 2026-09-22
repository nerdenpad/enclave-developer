import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "dotenv";
import { describe, expect, it } from "vitest";
import { demoArguments, isolatedChildEnvironment, providerEnvironment, serializeDemoEnv, validateLocalProfile } from "./prepare-demo.js";

const provider = { INFERENCE_BACKEND: "near-verified", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_MODEL: "reviewed-model",
  INFERENCE_API_KEY: "synthetic-test-token", INFERENCE_BASE_URL: "https://completions.near.ai/v1",
  NEAR_VERIFIER_PYTHON: "work/venv/bin/python", NEAR_ATTESTATION_POLICY: "infra/near/reviewed.json" };
const local = { DEMO_PG_PORT: "15433", DEMO_REDIS_PORT: "16379", DEMO_RPC_PORT: "18545",
  DATABASE_URL: "postgres://enclave:enclave_demo@127.0.0.1:15433/enclave_demo", REDIS_URL: "redis://127.0.0.1:16379", ARC_RPC_URL: "http://127.0.0.1:18545",
  ARC_CHAIN_ID: "31337", TEE_MODE: "dev", NODE_ENV: "development", API_HOST: "127.0.0.1", API_PORT: "8789", API_BASE: "http://127.0.0.1:8789",
  PAYMENT_MODE: "mock", ALLOW_LOCAL_BOOTSTRAP: "true", ENCLAVE_CVM_PATH: "data/demo/cvm.json", ENCLAVE_DEPLOY_ENV_PATH: ".env.demo", ENCLAVE_ADDRESSES_PATH: "data/demo/addresses.json" };

describe("isolated local demo preparation helpers", () => {
  it("defaults to local echo preparation and keeps registration explicit", () => {
    expect(demoArguments([])).toEqual({ nearEnv: undefined, register: false, help: false });
    expect(demoArguments(["--register"])).toMatchObject({ register: true });
    expect(demoArguments(["--near-env", "source profile.env"])).toMatchObject({ nearEnv: "source profile.env" });
    expect(() => demoArguments(["--near-env"])).toThrow();
    expect(() => demoArguments(["--reset"])).toThrow();
    expect(() => demoArguments(["--register", "--near-env", "source.env"])).toThrow();
  });

  it("imports only provider settings and resolves Python/policy paths against the selected profile", () => {
    const directory = path.resolve("old-backend");
    const imported = providerEnvironment({ ...provider, DATABASE_URL: "postgres://do-not-use", DEPLOYER_PRIVATE_KEY: "do-not-use",
      DEMO_API_KEY: "do-not-use", ENCLAVE_CVM_PATH: "do-not-use", NODE_OPTIONS: "do-not-use" }, directory);
    expect(imported.NEAR_ATTESTATION_POLICY).toBe(path.join(directory, "infra", "near", "reviewed.json"));
    expect(imported.NEAR_VERIFIER_PYTHON).toBe(path.join(directory, "work", "venv", "bin", "python"));
    expect(imported).not.toHaveProperty("DATABASE_URL");
    expect(imported).not.toHaveProperty("DEPLOYER_PRIVATE_KEY");
    expect(imported).not.toHaveProperty("DEMO_API_KEY");
    expect(imported).not.toHaveProperty("NODE_OPTIONS");
  });

  it.each(["http://completions.near.ai/v1", "https://attacker.test/v1", "https://completions.near.ai.attacker.test/v1",
    "https://user:password@completions.near.ai/v1", "https://completions.near.ai/v1?token=secret", "https://completions.near.ai/v1#fragment"])("rejects an unsafe provider endpoint without echoing credentials: %s", (url) => {
    expect(() => providerEnvironment({ ...provider, INFERENCE_BASE_URL: url }, ".")).toThrow("direct HTTPS");
  });

  it("requires complete NEAR opt-in and keeps command-only Python paths portable", () => {
    expect(() => providerEnvironment({ ...provider, INFERENCE_ALLOW_REMOTE: "false" }, ".")).toThrow("requires");
    expect(() => providerEnvironment({ ...provider, INFERENCE_API_KEY: "" }, ".")).toThrow("requires");
    expect(() => providerEnvironment({ ...provider, INFERENCE_API_KEY: "secret\nINJECTED=1" }, ".")).toThrow("multiline");
    expect(providerEnvironment({ ...provider, NEAR_VERIFIER_PYTHON: "python3" }, ".").NEAR_VERIFIER_PYTHON).toBe("python3");
  });

  it("round-trips Windows paths and special characters through both dotenv and Node's actual env-file reader", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "enclave-demo-env-"));
    const filename = path.join(directory, "profile.env");
    const values = { DEMO_TEST_PATH: "C:\\Users\\Example User\\venv\\python.exe", DEMO_TEST_TOKEN: 'synthetic$token#with"characters' };
    try {
      writeFileSync(filename, serializeDemoEnv(values));
      expect(parse(readFileSync(filename))).toEqual(values);
      const result = spawnSync(process.execPath, ["--env-file", filename, "--input-type=module", "-e",
        "process.stdout.write(JSON.stringify({DEMO_TEST_PATH:process.env.DEMO_TEST_PATH,DEMO_TEST_TOKEN:process.env.DEMO_TEST_TOKEN}))"],
      { env: isolatedChildEnvironment({}, process.env), encoding: "utf8", windowsHide: true });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(values);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects env-file injection and excludes inherited application credentials and Node hooks", () => {
    expect(() => serializeDemoEnv({ KEY: "value\nOTHER=1" })).toThrow();
    expect(() => serializeDemoEnv({ KEY: "cannot'close-quote" })).toThrow();
    expect(() => serializeDemoEnv({ "BAD KEY": "value" })).toThrow();
    const result = isolatedChildEnvironment({ DATABASE_URL: local.DATABASE_URL }, { Path: "node-directory", SYSTEMROOT: "windows",
      DATABASE_URL: "live-db", DEPLOYER_PRIVATE_KEY: "secret", INFERENCE_API_KEY: "secret", NODE_OPTIONS: "--import malicious" });
    expect(result).toEqual({ Path: "node-directory", SYSTEMROOT: "windows", DATABASE_URL: local.DATABASE_URL });
  });

  it.each([ ["DATABASE_URL", "postgres://remote/database"], ["ARC_RPC_URL", "https://real-chain.test"], ["ARC_CHAIN_ID", "1"],
    ["ENCLAVE_CVM_PATH", "data/cvm.json"], ["ENCLAVE_DEPLOY_ENV_PATH", ".env"], ["ENCLAVE_ADDRESSES_PATH", "data/addresses.json"],
    ["API_HOST", "0.0.0.0"], ["PAYMENT_MODE", "authorized"], ["DEMO_PG_PORT", "1"] ])("refuses altered isolation boundary %s", (key, value) => {
    expect(() => validateLocalProfile({ ...local, [key!]: value! })).toThrow();
  });
  it("accepts the intended isolated deployment without changing any settings", () => {
    expect(() => validateLocalProfile(local)).not.toThrow();
  });
});
