import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../frontend/", import.meta.url));
const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  cwd: frontend, env: { ...process.env, ENCLAVE_DEPLOY_TARGET: "node" }, stdio: "inherit", windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
