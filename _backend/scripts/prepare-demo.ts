import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import postgres from "postgres";
import { registerServingModel, registrationOptions } from "./register-serving-model.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const profilePath = path.join(root, ".env.demo"), stateDir = path.join(root, "data", "demo");
const markerPath = path.join(stateDir, "bootstrap.json"), project = "enclave-full-demo";
const addressKeys = ["ATTESTATION_VERIFIER_ADDRESS", "MODEL_REGISTRY_ADDRESS", "USAGE_METER_ADDRESS", "FEE_VAULT_ADDRESS",
  "ENCL_TOKEN_ADDRESS", "USDC_ADDRESS", "INSURANCE_STAKING_ADDRESS", "AGENT_MANDATE_ADDRESS", "CONFIDENTIAL_TRANSFER_ADDRESS"] as const;
const providerKeys = ["INFERENCE_BACKEND", "INFERENCE_BASE_URL", "INFERENCE_MODEL", "INFERENCE_API_KEY", "INFERENCE_TIMEOUT_MS",
  "INFERENCE_ALLOW_REMOTE", "NEAR_VERIFIER_PYTHON", "NEAR_ATTESTATION_POLICY", "NEAR_MAX_TOKENS"] as const;
type Profile = Record<string, string>;
type Marker = { version: 1; id: string; state: "preparing" | "ready"; checkpoint?: { number: string; hash: string } };

export function demoArguments(args: string[]) {
  let nearEnv: string | undefined, register = false, help = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--near-env" && args[index + 1] && !args[index + 1]!.startsWith("--")) nearEnv = args[++index];
    else if (args[index] === "--register") register = true;
    else if (args[index] === "--help") help = true;
    else throw new Error("Supported arguments: --near-env FILE, --register, --help.");
  }
  if (register && nearEnv) throw new Error("Configure the provider during initial preparation; --register only uses the existing demo profile.");
  return { nearEnv, register, help };
}

export function providerEnvironment(source: Profile, sourceDirectory: string): Profile {
  if (source.INFERENCE_BACKEND !== "near-verified" || source.INFERENCE_ALLOW_REMOTE !== "true"
    || !source.INFERENCE_MODEL?.trim() || !source.INFERENCE_API_KEY?.trim()
    || !source.NEAR_VERIFIER_PYTHON || !source.NEAR_ATTESTATION_POLICY) throw new Error("NEAR profile requires its model, API key, remote opt-in, verifier and reviewed policy.");
  let url: URL;
  try { url = new URL(source.INFERENCE_BASE_URL ?? ""); } catch { throw new Error("NEAR profile has an invalid endpoint."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !/^(?:[a-z0-9-]+\.)*completions\.near\.ai$/i.test(url.hostname)) throw new Error("NEAR profile must use a direct HTTPS completions.near.ai endpoint.");
  const result: Profile = {};
  for (const key of providerKeys) {
    const value = source[key];
    if (value !== undefined) {
      if (/[\r\n\0]/.test(value)) throw new Error("NEAR profile contains an unsupported multiline setting.");
      result[key] = value;
    }
  }
  result.NEAR_ATTESTATION_POLICY = path.resolve(sourceDirectory, result.NEAR_ATTESTATION_POLICY!);
  const python = result.NEAR_VERIFIER_PYTHON!;
  if (python.includes("/") || python.includes("\\")) result.NEAR_VERIFIER_PYTHON = path.resolve(sourceDirectory, python);
  return result;
}

export function serializeDemoEnv(profile: Profile) {
  return "# Local demo only. Contains credentials; never commit or expose to browser bundles.\n" + Object.entries(profile).map(([key, value]) => {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0'`]/.test(value)) throw new Error("Demo environment contains an unsupported value.");
    // Single quotes preserve Windows paths, #, $, spaces and double quotes in dotenv and Node --env-file.
    return `${key}='${value}'`;
  }).join("\n") + "\n";
}

export function isolatedChildEnvironment(profile: Profile, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const permitted = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir", "home", "userprofile", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata", "docker_host", "docker_context", "docker_config"]);
  for (const [key, value] of Object.entries(inherited)) if (permitted.has(key.toLowerCase())) environment[key] = value;
  return { ...environment, ...profile };
}

function run(command: string, args: string[], profile: Profile, label: string) {
  const result = spawnSync(command, args, { cwd: root, env: isolatedChildEnvironment(profile, process.env), encoding: "utf8", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], maxBuffer: 8 * 1024 * 1024 });
  // Seed and third-party errors can contain credentials. Never relay child stdout/stderr or command values.
  if (result.error || result.status !== 0) throw new Error(`${label} failed. Child output was withheld because it may contain credentials; inspect the local configuration and service status.`);
  return result.stdout.trim();
}
function compose(args: string[], profile: Profile) {
  return run("docker", ["compose", "--env-file", profilePath, "-p", project, "-f", "docker-compose.demo.yml", ...args], profile, "Demo Docker Compose");
}
function script(name: string, profile: Profile) { run(process.execPath, ["--import", "tsx", name], profile, name); }
async function rpc(profile: Profile, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(profile.ARC_RPC_URL!, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await response.json() as { error?: unknown; result?: unknown };
  if (!response.ok || body.error || body.result === undefined) throw new Error("Local demo chain request failed.");
  return body.result;
}
function readProfile() { return parse(readFileSync(profilePath)) as Profile; }
export function validateLocalProfile(profile: Profile) {
  for (const key of ["DEMO_PG_PORT", "DEMO_REDIS_PORT", "DEMO_RPC_PORT"]) {
    if (!/^\d+$/.test(profile[key] ?? "") || Number(profile[key]) < 1024 || Number(profile[key]) > 65535) throw new Error("Invalid demo port.");
  }
  if (profile.DATABASE_URL !== `postgres://enclave:enclave_demo@127.0.0.1:${profile.DEMO_PG_PORT}/enclave_demo`
    || profile.REDIS_URL !== `redis://127.0.0.1:${profile.DEMO_REDIS_PORT}`
    || profile.ARC_RPC_URL !== `http://127.0.0.1:${profile.DEMO_RPC_PORT}`
    || profile.ARC_CHAIN_ID !== "31337" || profile.TEE_MODE !== "dev" || profile.NODE_ENV !== "development"
    || profile.API_HOST !== "127.0.0.1" || profile.API_PORT !== "8789" || profile.API_BASE !== "http://127.0.0.1:8789"
    || profile.PAYMENT_MODE !== "mock" || profile.ALLOW_LOCAL_BOOTSTRAP !== "true"
    || profile.ENCLAVE_CVM_PATH !== "data/demo/cvm.json" || profile.ENCLAVE_DEPLOY_ENV_PATH !== ".env.demo"
    || profile.ENCLAVE_ADDRESSES_PATH !== "data/demo/addresses.json") throw new Error("Demo profile isolation settings changed; no preparation was performed.");
}

async function main() {
  const options = demoArguments(process.argv.slice(2));
  if (options.help) {
    console.log("Prepare an isolated local demo (three Docker containers, API port 8789).\nInitial optional provider: --near-env PATH. After starting the API: --register.\nExisting ready environments are verified, never seeded or redeployed. No inference is requested.");
    return;
  }
  process.chdir(root);
  if (options.register) {
    const profile = readProfile(); validateLocalProfile(profile);
    const result = await registerServingModel(registrationOptions(profile, ["--apply", "--bootstrap"]));
    if (result.state !== "approved") throw new Error("Serving model is not approved yet.");
    console.log("Demo serving model is registered and approved. No inference was requested."); return;
  }
  const dockerEndpoint = process.env.DOCKER_HOST || run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {}, "Docker context check");
  if (!/^(unix|npipe):\/\//.test(dockerEndpoint)) throw new Error("Demo bootstrap requires a local Docker socket or Windows named pipe.");
  let marker: Marker | undefined;
  if (existsSync(markerPath)) marker = JSON.parse(readFileSync(markerPath, "utf8")) as Marker;
  if (marker && (marker.version !== 1 || marker.state !== "ready" || !marker.id || !marker.checkpoint)) throw new Error("Demo initialization is incomplete. Refusing automatic seed/deploy; see docs/frontend-integration.md for explicit recovery.");
  if (!marker && (existsSync(profilePath) || existsSync(stateDir))) throw new Error("Unmanaged demo profile/state already exists; refusing to overwrite it.");
  let profile: Profile;
  if (marker) {
    if (options.nearEnv) throw new Error("Existing demo provider is preserved. Change .env.demo intentionally and restart the API, then run --register.");
    profile = readProfile(); validateLocalProfile(profile);
  } else {
    const existing = run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], {}, "Docker project ownership check");
    const volumes = run("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], {}, "Docker volume ownership check");
    if (existing || volumes) throw new Error(`The ${project} project already owns Docker resources but has no matching local manifest; refusing to adopt them.`);
    const defaults = parse(readFileSync(path.join(root, ".env.example"))) as Profile;
    const provider = options.nearEnv ? providerEnvironment(parse(readFileSync(path.resolve(options.nearEnv))), path.dirname(path.resolve(options.nearEnv))) : {};
    if (provider.NEAR_ATTESTATION_POLICY && !existsSync(provider.NEAR_ATTESTATION_POLICY)) throw new Error("The selected NEAR policy file does not exist.");
    profile = { ...defaults, ...provider, NODE_ENV: "development", LOG_LEVEL: "info", API_HOST: "127.0.0.1", API_PORT: "8789", API_BASE: "http://127.0.0.1:8789",
      DEMO_PG_PORT: "15433", DEMO_REDIS_PORT: "16379", DEMO_RPC_PORT: "18545",
      DATABASE_URL: "postgres://enclave:enclave_demo@127.0.0.1:15433/enclave_demo", REDIS_URL: "redis://127.0.0.1:16379", ARC_RPC_URL: "http://127.0.0.1:18545",
      ARC_CHAIN_ID: "31337", CHAIN_CONFIRMATIONS: "0", CHAIN_DEPLOYMENT_ID: `demo-${randomUUID()}`,
      TEE_MODE: "dev", PAYMENT_MODE: "mock", ALLOW_LOCAL_BOOTSTRAP: "true", INFERENCE_HEALTH_PATH: "", AGENT_RUNTIME_ENABLED: "false",
      SERVING_IMAGE_ID: "enclave-demo-v1", TCB_POLICY_VERSION: "1", NEAR_MAX_TOKENS: "96", DEMO_API_KEY: `enclave_demo_${randomBytes(24).toString("hex")}`,
      ENCLAVE_CVM_PATH: "data/demo/cvm.json", ENCLAVE_DEPLOY_ENV_PATH: ".env.demo", ENCLAVE_ADDRESSES_PATH: "data/demo/addresses.json" };
    validateLocalProfile(profile);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(profilePath, serializeDemoEnv(profile), { flag: "wx", mode: 0o600 });
    marker = { version: 1, id: randomUUID(), state: "preparing" };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2), { flag: "wx", mode: 0o600 });
  }
  console.log(`Starting only the ${project} PostgreSQL, Redis and Anvil containers.`);
  compose(["up", "-d", "--wait", "--wait-timeout", "90"], profile);
  let available = false;
  for (let index = 0; index < 40; index++) {
    try { if (await rpc(profile, "eth_chainId") === "0x7a69") { available = true; break; } } catch { /* Local startup only. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!available || !String(await rpc(profile, "web3_clientVersion")).toLowerCase().includes("anvil")) throw new Error("The isolated endpoint is not local Anvil chain 31337.");
  const sql = postgres(profile.DATABASE_URL!, { max: 1 });
  try {
    if (marker.state === "ready") {
      const identities = await sql`SELECT id FROM enclave_demo_identity`;
      if (identities.length !== 1 || identities[0]!.id !== marker.id) throw new Error("Demo database identity changed; refusing to seed or redeploy.");
      const block = await rpc(profile, "eth_getBlockByNumber", [marker.checkpoint!.number, false]) as { hash?: string } | null;
      if (block?.hash !== marker.checkpoint!.hash) throw new Error("Demo chain history changed; restore its matching state before continuing.");
      for (const key of addressKeys) {
        if (!/^0x[0-9a-fA-F]{40}$/.test(profile[key] ?? "") || await rpc(profile, "eth_getCode", [profile[key], "latest"]) === "0x") throw new Error("Demo contract deployment is missing; refusing automatic replacement.");
      }
      if (!existsSync(path.join(root, profile.ENCLAVE_CVM_PATH!))) throw new Error("Demo CVM keys are missing; restore the original demo state instead of generating replacement keys.");
      script("scripts/compile-contracts.ts", profile);
      console.log("Existing demo state verified. Seed and deployment were skipped.");
    } else {
      const tables = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
      if (tables.length || await rpc(profile, "eth_blockNumber") !== "0x0") throw new Error("Fresh demo expected an empty database and chain; no seed or deployment was performed.");
      console.log("Compiling contracts, migrating, seeding once and deploying local contracts.");
      script("scripts/compile-contracts.ts", profile);
      script("packages/db/src/migrate.ts", profile);
      script("packages/db/src/seed.ts", profile);
      script("scripts/deploy-local.ts", profile);
      profile = readProfile();
      await sql`CREATE TABLE enclave_demo_identity (id text PRIMARY KEY)`;
      await sql`INSERT INTO enclave_demo_identity (id) VALUES (${marker.id})`;
      const checkpoint = await rpc(profile, "eth_getBlockByNumber", ["latest", false]) as { number: string; hash: string };
      marker = { ...marker, state: "ready", checkpoint: { number: checkpoint.number, hash: checkpoint.hash } };
      writeFileSync(markerPath, JSON.stringify(marker, null, 2), { mode: 0o600 });
      console.log("Local demo initialized; credentials are stored only in ignored .env.demo.");
    }
  } finally { await sql.end({ timeout: 5 }); }
  console.log(`API: node --env-file=.env.demo --import tsx apps/api/src/index.ts\nWorker: node --env-file=.env.demo --import tsx apps/worker/src/index.ts\nAfter API startup: node --import tsx scripts/prepare-demo.ts --register\nStop API/worker first, then: docker compose --env-file .env.demo -p ${project} -f docker-compose.demo.yml stop`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error("Demo preparation failed. No credentials or child output were printed. Check Docker availability, unused demo ports, profile validity and the recovery instructions in docs/frontend-integration.md. Existing partial state is preserved."); process.exitCode = 1; });
}
