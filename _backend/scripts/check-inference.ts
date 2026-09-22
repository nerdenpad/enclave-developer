/** One small real inference request. Run explicitly after deploying the dev endpoint. */
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createOpenAICompatibleInference } from "@enclave/core";

export function loadInferenceEnvironment(env: NodeJS.ProcessEnv = process.env, paths = [
  fileURLToPath(new URL("../.env.modal", import.meta.url)), fileURLToPath(new URL("../.env", import.meta.url)),
]): NodeJS.ProcessEnv {
  // Match node --env-file=.env.modal followed by the API's base dotenv load:
  // explicit process environment wins, then the Modal overlay, then base values.
  const loaded = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  loadDotenv({ path: paths, processEnv: loaded });
  Object.assign(env, loaded);
  return env;
}

export async function checkInference(env: NodeJS.ProcessEnv = loadInferenceEnvironment()) {
  if (env.INFERENCE_BACKEND !== "openai-compatible") throw new Error("Inference check requires INFERENCE_BACKEND=openai-compatible");
  if ((env.TEE_MODE ?? "dev") !== "dev" || !["development", "test", undefined].includes(env.NODE_ENV)) {
    throw new Error("Inference check requires development software mode");
  }
  const baseUrl = env.INFERENCE_BASE_URL;
  const model = env.INFERENCE_MODEL;
  if (!baseUrl || !model) throw new Error("Set INFERENCE_BASE_URL and INFERENCE_MODEL in .env.modal first");
  if (!["true", "false", undefined].includes(env.INFERENCE_ALLOW_REMOTE)) throw new Error("Invalid INFERENCE_ALLOW_REMOTE");
  const infer = createOpenAICompatibleInference({
    baseUrl, model,
    allowRemote: env.INFERENCE_ALLOW_REMOTE === "true",
    ...(env.INFERENCE_API_KEY ? { apiKey: env.INFERENCE_API_KEY } : {}),
    ...(env.INFERENCE_HEALTH_PATH ? { healthPath: env.INFERENCE_HEALTH_PATH } : {}),
    timeoutMs: Number(env.INFERENCE_TIMEOUT_MS ?? "30000"),
    maxTokens: 32,
  });
  const start = Date.now();
  console.log("Checking development inference endpoint; cold startup can take several minutes.");
  const output = await infer(Buffer.from("Reply with the single word READY."));
  console.log(JSON.stringify({ ok: true, model, outputBytes: output.length, elapsedMs: Date.now() - start, teeMode: "dev" }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) checkInference().catch(() => {
  // Do not print arbitrary network/provider errors: they may contain credentials.
  console.error("Inference check failed. Check HTTPS URL, matching INFERENCE_API_KEY, model name and Modal deployment logs. No credentials or response content printed.");
  process.exitCode = 1;
});
