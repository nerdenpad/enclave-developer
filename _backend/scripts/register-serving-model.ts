import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

export type RegistrationOptions = { apiBase: string; apiKey: string; model: string; apply: boolean; bootstrap: boolean };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const hash32 = (value: unknown): value is string => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value);
const listingId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

export function registrationOptions(env: NodeJS.ProcessEnv, args: string[]): RegistrationOptions {
  let model = env.INFERENCE_MODEL;
  let apply = false;
  let bootstrap = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--apply") apply = true;
    else if (args[i] === "--bootstrap") bootstrap = true;
    else if (args[i] === "--model" && args[i + 1] && !args[i + 1]!.startsWith("--")) model = args[++i];
    else throw new Error("Supported arguments: --model MODEL_ID, --apply, --bootstrap. Default: read-only dry run.");
  }
  if (!model || model.trim() !== model || model.length > 512 || /[\x00-\x1f\x7f]/.test(model)) {
    throw new Error("Set INFERENCE_MODEL or --model to the exact model ID used by the running gateway.");
  }
  let base: URL;
  try { base = new URL(env.API_BASE ?? "http://127.0.0.1:8787"); }
  catch { throw new Error("API_BASE must be a loopback HTTP(S) origin."); }
  const loopback = base.hostname === "localhost" || base.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(base.hostname);
  if (!loopback || !["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("API_BASE must be a loopback HTTP(S) origin without credentials, path, query or fragment.");
  }
  return { apiBase: base.origin, apiKey: env.ENCLAVE_API_KEY || env.DEMO_API_KEY || "enclave_dev_key", model, apply, bootstrap };
}

/** Register only the requested model/code pair. No deployment, seed, reset or inference calls. */
export async function registerServingModel(options: RegistrationOptions) {
  async function request(route: string, body?: JsonObject): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${options.apiBase}${route}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(60_000),
        headers: body ? { accept: "application/json", "content-type": "application/json", "x-api-key": options.apiKey } : { accept: "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error(`Local API request failed for ${route}; check the gateway. Mutations are never retried automatically.`); }
    if (!response.ok) throw new Error(`Local API returned HTTP ${response.status} for ${route}. Check admin access, contract configuration and ALLOW_LOCAL_BOOTSTRAP; no automatic retry was made.`);
    try { return await response.json(); }
    catch { throw new Error(`Local API returned invalid JSON for ${route}.`); }
  }

  const health = await request("/health");
  if (!object(health) || !Number.isSafeInteger(health.chainId)) throw new Error("Gateway returned an invalid chain identity.");
  if (options.apply && (health.chainId !== 31337 || health.teeMode !== "dev")) {
    throw new Error("Applying model registration requires the running gateway to use local Anvil chain 31337 and TEE_MODE=dev.");
  }
  const [quote, catalog] = await Promise.all([request("/v1/attestation/quote"), request("/v1/marketplace")]);
  if (!object(quote) || !hash32(quote.measurement)) throw new Error("Gateway returned an invalid serving code measurement.");
  if (!Array.isArray(catalog)) throw new Error("Gateway returned an invalid marketplace catalog.");
  const modelHash = `0x${createHash("sha256").update(`model:${options.model}`).digest("hex")}`;
  const codeHash = quote.measurement;
  let row = catalog.find((entry): entry is JsonObject => object(entry)
    && typeof entry.modelHash === "string" && entry.modelHash.toLowerCase() === modelHash
    && typeof entry.codeHash === "string" && entry.codeHash.toLowerCase() === codeHash.toLowerCase());
  if (row?.revoked) throw new Error("The requested model/code pair is revoked. This helper never restores revoked listings.");
  if (row && !listingId(row.listingId)) throw new Error("Existing catalog entry has no valid on-chain listing ID; reconcile it before registration.");
  const result = { mode: options.apply ? "apply" : "dry-run", model: options.model, modelHash, codeHash,
    listingId: row?.listingId as number | undefined, state: "unlisted", availableAt: undefined as string | undefined, actions: [] as string[] };
  if (!row) {
    result.actions.push("POST /v1/marketplace/list (bps=0; locks the configured ENCL listing deposit)");
    if (!options.apply) {
      result.actions.push(options.bootstrap ? "POST /v1/marketplace/:id/bootstrap-approve (explicit local bootstrap)" : "POST /v1/marketplace/:id/approve after the one-hour timelock");
      return result;
    }
    const created = await request("/v1/marketplace/list", { modelHash, codeHash, version: `local:${options.model}`, bps: 0 });
    if (!object(created) || !listingId(created.listingId)) throw new Error("Listing response lacks an on-chain ID. Inspect the catalog before retrying; no approval was submitted.");
    row = created;
    result.listingId = created.listingId;
  }
  const statusRoute = `/v1/marketplace/${result.listingId}/approval`;
  const status = await request(statusRoute);
  if (!object(status) || !["pending", "ready", "approved", "revoked"].includes(String(status.state))) throw new Error("Gateway returned an invalid listing approval state.");
  if (status.state === "revoked") throw new Error("On-chain listing is revoked. This helper never restores revoked listings.");
  result.state = String(status.state);
  if (typeof status.availableAt === "string") result.availableAt = status.availableAt;
  if (status.state === "approved" && row.approved === true) return result;
  const approvalRoute = status.state === "approved" || !options.bootstrap
    ? `/v1/marketplace/${result.listingId}/approve`
    : `/v1/marketplace/${result.listingId}/bootstrap-approve`;
  if (status.state === "pending" && !options.bootstrap) {
    result.actions.push(`Wait until chain timestamp ${result.availableAt ?? "availableAt"}, then re-run with --apply (or explicitly use --bootstrap on local Anvil).`);
    return result;
  }
  result.actions.push(`POST ${approvalRoute}`);
  if (!options.apply) return result;
  await request(approvalRoute, {});
  const verified = await request(statusRoute);
  if (!object(verified) || verified.state !== "approved") throw new Error("Approval was submitted but the contract does not report approved; inspect the transaction before retrying.");
  result.state = "approved";
  return result;
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log("Register the running gateway's model on existing local Anvil contracts.\nUses INFERENCE_MODEL, API_BASE, ENCLAVE_API_KEY or DEMO_API_KEY.\nFlags: --model MODEL_ID, --apply, --bootstrap. Without --apply, performs only public GET requests.\nStart the gateway with the same model configuration first. --bootstrap also requires ALLOW_LOCAL_BOOTSTRAP=true on the gateway.");
    return;
  }
  // A Node --env-file profile or shell variables take precedence over the base local .env.
  loadDotenv({ path: new URL("../.env", import.meta.url) });
  console.log(JSON.stringify(await registerServingModel(registrationOptions(process.env, process.argv.slice(2))), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Model registration failed."); process.exitCode = 1; });
}
