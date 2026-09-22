import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const contracts = fileURLToPath(new URL("../contracts", import.meta.url));
const coverage = process.argv.includes("--coverage");
const extraArgs = process.argv.slice(2).filter((argument) => argument !== "--coverage");
const native = spawnSync("forge", ["--version"], { stdio: "ignore" });
// The deployment script still uses forge-std; the tests have a self-contained harness.
const args = coverage
  ? ["coverage", "--skip", "script", "--exclude-tests", "--report", "summary", "--report", "lcov", ...extraArgs]
  : ["test", "--skip", "script", "-vv", ...extraArgs];
const command = native.status === 0 ? "forge" : "docker";
const commandArgs = native.status === 0 ? args : [
  "run", "--rm", "--entrypoint", "forge",
  "--mount", `type=bind,source=${contracts},target=/work`,
  "--workdir", "/work", "ghcr.io/foundry-rs/foundry:latest", ...args,
];
const result = spawnSync(command, commandArgs, { cwd: contracts, stdio: "inherit" });
if (result.error) {
  console.error("Contract tests require native Forge or a running Docker engine.", result.error.message);
}
process.exit(result.status ?? 1);
