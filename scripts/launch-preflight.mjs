import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const launcherHelp = `Usage: node scripts/enclave.mjs COMMAND

  dev                          Start the prepared local demo and frontend
  simulate                     Start with the local Echo fixture
  prepare [--near-env FILE]    Prepare the isolated local demo
  register                     Register the active local serving model
  stop                         Stop demo containers, preserving their volumes
  check                        Check prerequisites without starting services
  --help                       Show this help without requiring dependencies

Run npm run setup from the repository root first. Use Node.js 22.12+ and
a running local Docker engine with Compose v2. Start Docker manually.
Relative --near-env paths resolve from the directory where you run this command.
See docs/development.md for setup, test commands and local trust boundaries.`;

export function launcherArguments(argv, cwd = process.cwd()) {
  const [command = "dev", ...args] = argv;
  if (["--help", "-h", "help"].includes(command) && !args.length) return { command: "help", args: [] };
  if (!["dev", "simulate", "prepare", "register", "stop", "check"].includes(command)) {
    throw new Error("Unknown command. Run node scripts/enclave.mjs --help for usage.");
  }
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "help", args: [] };
  if (command !== "prepare" && args.length) throw new Error("Only prepare accepts --near-env FILE. Use --help for usage.");
  if (command === "prepare" && args.length) {
    if (args.length !== 2 || args[0] !== "--near-env" || !args[1] || args[1].startsWith("--")) {
      throw new Error("Use prepare [--near-env FILE]. Quote a profile path that contains spaces.");
    }
    return { command, args: ["--near-env", path.resolve(cwd, args[1])] };
  }
  return { command, args };
}

/** Read-only checks; never invoke compose up, create demo state or start an engine. */
export function launchPreflight({ root, command, args = [], nodeVersion = process.versions.node,
  environment = process.env, exists = existsSync, runSync = spawnSync }) {
  const [major, minor] = nodeVersion.split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || major === 22 && minor < 12) {
    throw new Error("The local launcher requires Node.js 22.12+ (Node.js 24 LTS is supported). Update Node and rerun npm run setup.");
  }
  const backend = path.join(root, "_backend"), frontend = path.join(root, "frontend");
  if (!exists(path.join(backend, "package.json")) || !exists(path.join(frontend, "package.json"))) {
    throw new Error("The repository is incomplete. Keep scripts/, _backend/ and frontend/ in the same checkout.");
  }
  if (command !== "stop") {
    if (!exists(path.join(backend, "node_modules", "tsx", "package.json"))) {
      throw new Error("Backend dependencies are missing. Run npm run setup from the repository root.");
    }
    if (["dev", "simulate", "check"].includes(command) && !exists(path.join(frontend, "node_modules", "vite", "bin", "vite.js"))) {
      throw new Error("Frontend dependencies are missing. Run npm run setup from the repository root.");
    }
  }
  if (command === "prepare" && args[0] === "--near-env" && !exists(args[1])) {
    throw new Error("The selected NEAR profile does not exist. Pass an existing file; relative paths use your current directory.");
  }
  if (["register", "stop"].includes(command) && !exists(path.join(backend, ".env.demo"))) {
    throw new Error("No demo profile exists in this checkout. Run npm run demo:prepare first.");
  }
  if (command === "register") return {};
  const docker = (argv, failure) => {
    const result = runSync("docker", argv, { env: environment, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536 });
    if (result.error || result.status !== 0) throw new Error(failure);
    return result.stdout?.trim() ?? "";
  };
  docker(["--version"], "Docker CLI is unavailable. Install Docker with Compose v2 and start its local engine manually.");
  docker(["compose", "version"], "Docker Compose v2 is unavailable. Install the Compose plugin before preparing the local demo.");
  const endpoint = environment.DOCKER_HOST || docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    "The Docker context could not be inspected. Select a working local Docker context and try again.");
  if (!/^(?:unix|npipe):\/\//.test(endpoint)) {
    throw new Error("The demo requires a local Docker socket or Windows named pipe. Select a local Docker context; remote engines are not supported.");
  }
  // Pin the inspected socket: a named context must not override DOCKER_HOST later.
  const dockerEnvironment = Object.fromEntries(Object.entries(environment).filter(([name]) => !["docker_host", "docker_context"].includes(name.toLowerCase())));
  dockerEnvironment.DOCKER_HOST = endpoint;
  const result = runSync("docker", ["info", "--format", "{{.ServerVersion}}"],
    { env: dockerEnvironment, encoding: "utf8", windowsHide: true, timeout: 5000, maxBuffer: 65536 });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) {
    throw new Error("The local Docker engine is not available. Start Docker manually and wait until docker info succeeds, then retry. The launcher does not start Docker.");
  }
  return { dockerEndpoint: endpoint };
}
