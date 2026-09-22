import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const root = process.cwd();
mkdirSync(path.join(root, "work"), { recursive: true });
const scratch = mkdtempSync(path.join(root, "work", "integration-"));
const project = `enclave-test-${process.pid}-${Date.now()}`;
const compose = ["compose", "-p", project, "-f", "docker-compose.test.yml"];
const env: NodeJS.ProcessEnv = {
  ...process.env, NODE_ENV: "test", ENCLAVE_INTEGRATION: "1", ALLOW_LOCAL_BOOTSTRAP: "true",
  PAYMENT_MODE: "mock", INFERENCE_BACKEND: "echo", INFERENCE_MODEL: "echo",
  ENCLAVE_CVM_PATH: path.join(scratch, "cvm.json"),
  ENCLAVE_DEPLOY_ENV_PATH: path.join(scratch, "test.env"),
  ENCLAVE_ADDRESSES_PATH: path.join(scratch, "addresses.json"),
  SERVING_IMAGE_ID: "enclave-echo-v1", TCB_POLICY_VERSION: "1", TEE_MODE: "dev",
  INFERENCE_PRICE_USDC: "0.1", ARC_CHAIN_ID: "31337", LOG_LEVEL: "fatal",
  DEPLOYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
};

function run(cmd: string, args: string[], capture = false): string {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})${result.stderr ?? ""}`);
  return (result.stdout ?? "").trim();
}
function tsx(script: string) { run(process.execPath, ["--import", "tsx", script]); }
function port(service: string, internal: number) { return run("docker", [...compose, "port", service, String(internal)], true).split(":").at(-1)!; }

try {
  run("docker", [...compose, "up", "-d", "--wait", "--wait-timeout", "90"]);
  env.DATABASE_URL = `postgres://enclave:enclave_test@127.0.0.1:${port("postgres", 5432)}/enclave_test`;
  env.REDIS_URL = `redis://127.0.0.1:${port("redis", 6379)}`;
  env.ARC_RPC_URL = `http://127.0.0.1:${port("anvil", 8545)}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(env.ARC_RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if ((await response.json() as { result?: string }).result === "0x7a69") break;
    } catch { /* Container may be running before RPC is ready. */ }
    if (attempt >= 30) throw new Error("Test Anvil did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  writeFileSync(env.ENCLAVE_DEPLOY_ENV_PATH!, "# Disposable integration environment\n");
  tsx("scripts/compile-contracts.ts");
  tsx("packages/db/src/migrate.ts");
  tsx("packages/db/src/migrate.ts"); // Schema migration must be idempotent.
  tsx("packages/db/src/seed.ts");
  tsx("scripts/deploy-local.ts");
  Object.assign(env, parse(readFileSync(env.ENCLAVE_DEPLOY_ENV_PATH!)));
  // Explicit opt-in only: this submits one small paid NEAR prompt. The default
  // integration and CI runs remain entirely offline with respect to inference.
  if (process.argv.includes("--near-live") || process.argv.includes("--near-live-only")) tsx("scripts/check-near-gateway.ts");
  for (const workspace of process.argv.includes("--near-live-only") ? [] : ["apps/api", "apps/worker"]) {
    run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--root", workspace, ...(process.argv.includes("--coverage") ? ["--coverage"] : [])]);
  }
} finally {
  // Only this run's randomly named project is removed; ordinary development containers are untouched.
  run("docker", [...compose, "down", "--volumes", "--remove-orphans"]);
}
