import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const backend = path.join(root, "_backend");
const frontend = path.join(root, "frontend");
const [command = "dev", ...args] = process.argv.slice(2);
const owned = new Set();
const shutdownPreload = pathToFileURL(path.join(root, "scripts", "shutdown-preload.mjs")).href;
let stopping = false;
let release;
const finished = new Promise((resolve) => { release = resolve; });

// Application settings come from the selected ignored profile, not an unrelated shell.
const systemKeys = new Set(["path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "tmpdir", "home", "userprofile", "appdata", "localappdata", "programfiles", "programfiles(x86)", "programdata", "docker_host", "docker_context", "docker_config", "term", "ci"]);
const systemEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => systemKeys.has(name.toLowerCase())));

function child(executable, argv, cwd, extraEnv = {}, service = false) {
  const result = spawn(executable, service ? ["--import", shutdownPreload, ...argv] : argv,
    { cwd, env: { ...systemEnv, ...extraEnv }, stdio: service ? ["inherit", "inherit", "inherit", "ipc"] : "inherit", windowsHide: true });
  owned.add(result);
  result.once("close", () => owned.delete(result));
  result.once("error", () => {
    console.error("A local process could not start. Check dependencies and executable availability.");
    void shutdown(1);
  });
  if (service) result.once("exit", (code) => {
    if (!stopping) {
      console.error(`A service stopped unexpectedly (exit ${code ?? "signal"}). Stopping this launcher's other services.`);
      void shutdown(1);
    }
  });
  return result;
}

function run(executable, argv, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const task = child(executable, argv, cwd, extraEnv);
    task.once("error", () => reject(new Error("Unable to launch the required command.")));
    task.once("exit", (code) => code === 0 ? resolve() : reject(new Error("The local command failed; see its output above.")));
  });
}

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  const tasks = [...owned];
  const closed = tasks.map((task) => task.exitCode !== null || task.signalCode !== null ? Promise.resolve() : new Promise((resolve) => task.once("close", resolve)));
  for (const task of tasks) {
    if (task.exitCode !== null || task.signalCode !== null) continue;
    if (task.connected) task.send({ type: "enclave:shutdown" }, () => {});
    else if (process.platform !== "win32") task.kill("SIGTERM");
  }
  let deadline;
  await Promise.race([Promise.all(closed), new Promise((resolve) => { deadline = setTimeout(resolve, 31_000); })]);
  clearTimeout(deadline);
  for (const task of tasks) {
    if (task.exitCode !== null || task.signalCode !== null || !task.pid) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(task.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    } else task.kill("SIGKILL");
  }
  release();
}
process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
if (process.send) {
  process.on("message", (message) => { if (message?.type === "enclave:shutdown") void shutdown(0); });
  process.once("disconnect", () => { void shutdown(0); });
  process.channel?.unref();
}

function assertFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(1500);
    socket.once("connect", () => { socket.destroy(); reject(new Error(`Port ${port} is already in use. Stop that instance before starting this copy.`)); });
    socket.once("error", (error) => error.code === "ECONNREFUSED" ? resolve() : reject(new Error(`Unable to check port ${port}.`)));
    socket.once("timeout", () => { socket.destroy(); reject(new Error(`Port ${port} did not respond to the availability check.`)); });
  });
}

async function waitFor(url, predicate = () => true) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (stopping) throw new Error("Startup was interrupted.");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000), redirect: "error" });
      if (response.ok && await predicate(response)) return;
    } catch { /* Startup polling only; no inference or payment is retried. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("A local service did not become ready in time.");
}

async function prepare(extra = []) {
  await run(process.execPath, ["--import", "tsx", "scripts/prepare-demo.ts", ...extra], backend);
}
async function register() { await prepare(["--register"]); }

try {
  if (!["dev", "simulate", "prepare", "register", "stop"].includes(command)) throw new Error("Commands: dev, simulate, prepare [--near-env FILE], register, stop.");
  if (command !== "prepare" && args.length) throw new Error("Only prepare accepts additional arguments.");
  if (command === "stop") {
    if (!existsSync(path.join(backend, ".env.demo"))) throw new Error("No demo profile exists in this copy.");
    const context = process.env.DOCKER_HOST || spawnSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
      { env: systemEnv, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536 }).stdout?.trim();
    if (!context || !/^(unix|npipe):\/\//.test(context)) throw new Error("Stopping the demo requires a local Docker socket or Windows named pipe.");
    await run("docker", ["compose", "--env-file", ".env.demo", "-p", "enclave-full-demo", "-f", "docker-compose.demo.yml", "stop"], backend,
      { DOCKER_HOST: context, DOCKER_CONTEXT: undefined });
  } else {
    if (!existsSync(path.join(backend, "node_modules", "tsx", "package.json"))) throw new Error("Backend dependencies are missing. Run npm run setup first.");
    if (command === "prepare") await prepare(args);
    if (command === "register") await register();
    if (command === "dev" || command === "simulate") {
      const simulation = command === "simulate";
      // Process-only overrides: preserve the reviewed NEAR profile on disk.
      const provider = simulation ? { INFERENCE_BACKEND: "echo", INFERENCE_MODEL: "echo", INFERENCE_API_KEY: "", INFERENCE_ALLOW_REMOTE: "false" } : {};
      if (!existsSync(path.join(frontend, "node_modules", "vite", "bin", "vite.js"))) throw new Error("Frontend dependencies are missing. Run npm run setup first.");
      await Promise.all([assertFree(8789), assertFree(5173)]);
      await prepare();
      if (stopping) throw new Error("Startup was interrupted.");
      child(process.execPath, ["--env-file=.env.demo", "--import", "tsx", "apps/api/src/index.ts"], backend, provider, true);
      await waitFor("http://127.0.0.1:8789/health", async (response) => {
        const health = await response.json();
        return health.teeMode === "dev" && health.chainId === 31337 && (!simulation || (health.inferenceBackend === "echo" && health.paymentMode === "mock"));
      });
      if (simulation) await run(process.execPath, ["--env-file=.env.demo", "--import", "tsx", "scripts/register-serving-model.ts", "--model", "echo", "--apply", "--bootstrap"], backend, provider);
      else await register();
      if (stopping) throw new Error("Startup was interrupted.");
      child(process.execPath, ["--env-file=.env.demo", "--import", "tsx", "apps/worker/src/index.ts"], backend, provider, true);
      child(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], frontend,
        { ENCLAVE_API_URL: "http://127.0.0.1:8789" }, true);
      await waitFor("http://127.0.0.1:5173/dashboard");
      console.log("Enclave is ready: http://127.0.0.1:5173/dashboard");
      if (simulation) console.log("SIMULATION: local Echo fixture, software attestation, Anvil test tokens. No GPU or real-USDC payments.");
      console.log("Use /api and the private DEMO_API_KEY from _backend/.env.demo. No credentials are printed.");
      console.log("Ctrl+C stops the API, worker and frontend. Then npm run demo:stop stops the three demo containers and preserves their volumes.");
      await finished;
    }
  }
} catch (error) {
  if (!stopping) console.error(error instanceof Error ? error.message : "Local startup failed.");
  await shutdown(1);
}
