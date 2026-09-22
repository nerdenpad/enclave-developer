import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import net from "node:net";
if (!existsSync("_backend/.env.demo")) throw new Error("Run npm run demo:prepare first. This check uses a prepared local demo and never sends an inference request.");
const service = spawn(process.execPath, ["scripts/enclave.mjs", "dev"], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
let output = "";
let closed = false;
let code;
service.stdout.on("data", (chunk) => { output += chunk.toString(); });
service.stderr.on("data", (chunk) => { output += chunk.toString(); });
const close = new Promise((resolve) => service.once("close", (value) => { closed = true; code = value; resolve(value); }));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isClosed = (port) => new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port });
  socket.setTimeout(1500);
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("error", (error) => resolve(error.code === "ECONNREFUSED"));
  socket.once("timeout", () => { socket.destroy(); resolve(false); });
});
try {
  for (let count = 0; count < 240 && !output.includes("Enclave is ready:") && !closed; count++) await pause(500);
  if (!output.includes("Enclave is ready:") || closed) throw new Error(`Launcher did not become ready (exit ${code ?? "pending"}; api=${output.includes("api_listen")}, frontend=${output.includes("VITE")}, worker=${output.includes("worker_listen")}).`);
  const env = parseEnv(readFileSync("_backend/.env.demo", "utf8"));
  const health = await (await fetch("http://127.0.0.1:5173/api/health")).json();
  const workspaceResponse = await fetch("http://127.0.0.1:5173/api/v1/workspace", { headers: { "x-api-key": env.DEMO_API_KEY } });
  if (!workspaceResponse.ok || health.inferenceBackend !== env.INFERENCE_BACKEND || health.chainId !== 31337 || !output.includes("worker_listen")) throw new Error("Combined services did not pass read-only checks.");
  const workspace = await workspaceResponse.json();
  console.log(JSON.stringify({ ready: true, provider: health.inferenceBackend, chain: health.chainId, authenticatedWorkspace: true, storedReceipts: workspace.receipts.length, providerCalls: 0 }));
  service.send({ type: "enclave:shutdown" });
  let deadline;
  const exit = await Promise.race([close, new Promise((resolve) => { deadline = setTimeout(() => resolve("timeout"), 40000); })]);
  clearTimeout(deadline);
  const portsClosed = await Promise.all([isClosed(8789), isClosed(5173)]);
  const shutdownHandlers = (output.match(/shutdown_initiated/g) || []).length;
  console.log(JSON.stringify({ exit, portsClosed, gracefulBackendShutdownHandlers: shutdownHandlers }));
  if (exit !== 0 || portsClosed.some((value) => !value) || shutdownHandlers < 2) throw new Error("Graceful shutdown verification failed.");
} catch (error) {
  console.error(error.message);
  if (service.connected) service.send({ type: "enclave:shutdown" });
  process.exitCode = 1;
}
