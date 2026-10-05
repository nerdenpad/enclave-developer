import { z } from "zod";
import { isAbsolute } from "node:path";
import { isIP } from "node:net";
import { withRelayKey } from "@enclave/core/relay-key";
import { createOpenAICompatibleInference, isConfiguredAddress } from "@enclave/core";
import { nearBaseUrl, nvidiaVerifierOptions } from "./near-provider.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  API_HOST: z.string().default("127.0.0.1"),
  WALLET_AUTH_ORIGIN: z.string().url().refine(value => { const url = new URL(value); return url.origin === value && url.protocol === "https:"; }, "Wallet login requires an exact HTTPS origin").optional(),
  WALLET_AUTH_TRUSTED_PROXY_IPS: z.string().max(2048).default("").transform(value => value === "" ? [] : value.split(",").map(ip => ip.trim()))
    .pipe(z.array(z.string().refine(ip => isIP(ip) !== 0 && !ip.includes("%"), "Trusted wallet proxy must be an exact IP address")).max(16)),
  API_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  ARC_RPC_URL: z.string().default("http://127.0.0.1:8545"),
  ARC_RPC_MAX_RPS: z.coerce.number().int().min(1).max(20).optional(),
  ARC_CHAIN_ID: z.coerce.number().int().positive().default(31337),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(1000).optional(),
  CHAIN_DEPLOYMENT_ID: z.string().min(1).optional(),
  ATTESTATION_VERIFIER_ADDRESS: z
    .string()
    .default("0x0000000000000000000000000000000000000001"),
  USAGE_METER_ADDRESS: z.string().default("0x0000000000000000000000000000000000000004"),
  FEE_VAULT_ADDRESS: z.string().default("0x0000000000000000000000000000000000000002"),
  USDC_ADDRESS: z.string().default("0x0000000000000000000000000000000000000003"),
  ENCL_TOKEN_ADDRESS: z.string().default("0x0000000000000000000000000000000000000005"),
  INSURANCE_STAKING_ADDRESS: z.string().default("0x0000000000000000000000000000000000000006"),
  MODEL_REGISTRY_ADDRESS: z.string().default("0x0000000000000000000000000000000000000007"),
  AGENT_MANDATE_ADDRESS: z.string().default("0x0000000000000000000000000000000000000008"),
  DEPLOYER_PRIVATE_KEY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .default("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80")
    .transform((value) => value as `0x${string}`),
  SERVING_IMAGE_ID: z.string().default("enclave-echo-v1"),
  TCB_POLICY_VERSION: z.coerce.number().int().positive().default(1),
  INFERENCE_PRICE_USDC: z.coerce.number().positive().default(0.1),
  TEE_MODE: z.enum(["dev", "managed-near"]).default("dev"),
  PRODUCTION_RELEASE_MANIFEST: z.string().min(1).optional(),
  ENCLAVE_CVM_PATH: z.string().min(1).optional(),
  PAYMENT_MODE: z.enum(["mock", "authorized"]).default("mock"),
  USDC_EIP712_NAME: z.string().min(1).default("USD Coin"),
  USDC_EIP712_VERSION: z.string().min(1).default("2"),
  ALLOW_LOCAL_BOOTSTRAP: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  INFERENCE_BACKEND: z.enum(["echo", "openai-compatible", "near-verified"]).default("echo"),
  INFERENCE_BASE_URL: z.string().url().default("http://127.0.0.1:8000/v1"),
  INFERENCE_MODEL: z.string().min(1).default("echo"),
  INFERENCE_ALLOW_REMOTE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  INFERENCE_API_KEY: z.string().optional(),
  INFERENCE_HEALTH_PATH: z.string().optional(),
  INFERENCE_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
  NEAR_VERIFIER_PYTHON: z.string().min(1).optional(),
  NVIDIA_VERIFIER_MODE: z.enum(["nras", "local"]).default("nras"),
  NVIDIA_NVAT_BINARY: z.string().min(1).optional(),
  NVIDIA_NVAT_LIBRARY: z.string().min(1).optional(),
  NEAR_ATTESTATION_POLICY: z.string().min(1).optional(),
  NEAR_ATTESTATION_POLICY_SHA256: z.string().regex(/^0x[0-9a-f]{64}$/).optional(),
  NEAR_ENDPOINT_PROFILE: z.enum(["cloud", "direct-experimental"]).default("cloud"),
  NEAR_DIRECT_ADMISSION_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(1),
  NEAR_MAX_TOKENS: z.coerce.number().int().positive().max(4096).default(512),
  NEAR_ENABLE_THINKING: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  AGENT_RUNTIME_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  AGENT_RUNTIME_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  AGENT_RUNTIME_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(8),
  AGENT_RUNTIME_MAX_BUDGET_UNITS: z.coerce.number().int().positive().max(1_000_000_000_000).default(1_000_000),
  AGENT_RUNTIME_MAX_DURATION_MS: z.coerce.number().int().min(1000).max(86_400_000).default(900_000),
}).superRefine((env, ctx) => {
  const priceUnits = Math.round(env.INFERENCE_PRICE_USDC * 1_000_000);
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) ctx.addIssue({ code: "custom", path: ["INFERENCE_PRICE_USDC"], message: "Price must be at least one USDC unit and fit safe integer units" });
  if (env.NODE_ENV === "production") {
    const requireSetting = (valid: boolean, field: string, message: string): void => {
      if (!valid) ctx.addIssue({ code: "custom", path: [field], message });
    };
    requireSetting(env.TEE_MODE === "managed-near" && env.INFERENCE_BACKEND === "near-verified", "TEE_MODE", "Production requires the managed NEAR hardware TEE verification profile");
    const productionEndpoint = env.NEAR_ENDPOINT_PROFILE === "direct-experimental"
      ? /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.completions\.near\.ai\/v1$/.test(env.INFERENCE_BASE_URL)
      : env.INFERENCE_BASE_URL === "https://cloud-api.near.ai/v1";
    requireSetting(productionEndpoint, "INFERENCE_BASE_URL", "Production requires the endpoint selected by the explicit NEAR profile");
    requireSetting(env.ARC_CHAIN_ID === 5042 && env.PAYMENT_MODE === "authorized", "PAYMENT_MODE", "Production requires authorized Arc Mainnet settlement");
    requireSetting(!env.ALLOW_LOCAL_BOOTSTRAP, "ALLOW_LOCAL_BOOTSTRAP", "Production forbids local bootstrap");
    requireSetting(Boolean(env.WALLET_AUTH_ORIGIN), "WALLET_AUTH_ORIGIN", "Production requires HTTPS wallet authentication");
    requireSetting(Boolean(env.PRODUCTION_RELEASE_MANIFEST), "PRODUCTION_RELEASE_MANIFEST", "Production requires an independently reviewed acceptance manifest");
    requireSetting(Boolean(env.ENCLAVE_CVM_PATH && isAbsolute(env.ENCLAVE_CVM_PATH)), "ENCLAVE_CVM_PATH", "Production requires an explicit persistent gateway key file");
    requireSetting(Boolean(env.NEAR_ATTESTATION_POLICY_SHA256), "NEAR_ATTESTATION_POLICY_SHA256", "Production requires a pinned reviewed provider policy");
    requireSetting(env.CHAIN_CONFIRMATIONS !== undefined && env.CHAIN_CONFIRMATIONS >= 1, "CHAIN_CONFIRMATIONS", "Production requires an explicit positive confirmation policy");
    requireSetting(env.USDC_ADDRESS.toLowerCase() === "0x3600000000000000000000000000000000000000" && env.USDC_EIP712_NAME === "USDC" && env.USDC_EIP712_VERSION === "2", "USDC_ADDRESS", "Production requires the reviewed Arc USDC domain");
    for (const field of ["ATTESTATION_VERIFIER_ADDRESS", "MODEL_REGISTRY_ADDRESS", "USAGE_METER_ADDRESS", "FEE_VAULT_ADDRESS", "ENCL_TOKEN_ADDRESS", "INSURANCE_STAKING_ADDRESS", "AGENT_MANDATE_ADDRESS"] as const) {
      requireSetting(isConfiguredAddress(env[field]), field, "Production requires explicit deployed contract addresses");
    }
    try {
      const rpc = new URL(env.ARC_RPC_URL);
      requireSetting(rpc.protocol === "https:" && !rpc.username && !rpc.password && !rpc.hash, "ARC_RPC_URL", "Production requires an HTTPS RPC endpoint");
    } catch { requireSetting(false, "ARC_RPC_URL", "Production requires an HTTPS RPC endpoint"); }
    requireSetting(!/^(echo|enclave-echo-v1)$/.test(env.INFERENCE_MODEL) && env.SERVING_IMAGE_ID !== "enclave-echo-v1", "SERVING_IMAGE_ID", "Production forbids development serving identities");
  }
  if (env.TEE_MODE === "managed-near" && env.INFERENCE_BACKEND !== "near-verified") {
    ctx.addIssue({ code: "custom", path: ["INFERENCE_BACKEND"], message: "Managed NEAR sessions require verified inference without a fallback" });
  }
  if (env.NEAR_ENDPOINT_PROFILE === "direct-experimental" && (env.TEE_MODE !== "managed-near" || env.INFERENCE_BACKEND !== "near-verified")) {
    ctx.addIssue({ code: "custom", path: ["NEAR_ENDPOINT_PROFILE"], message: "The experimental direct profile requires managed NEAR hardware verification" });
  }
  if (env.NEAR_DIRECT_ADMISSION_ATTEMPTS > 1 && (env.NEAR_ENDPOINT_PROFILE !== "direct-experimental"
      || env.TEE_MODE !== "managed-near" || env.INFERENCE_BACKEND !== "near-verified" || !env.NEAR_ATTESTATION_POLICY_SHA256)) {
    ctx.addIssue({ code: "custom", path: ["NEAR_DIRECT_ADMISSION_ATTEMPTS"], message: "Repeated direct admission requires the explicit managed direct profile and a pinned reviewed provider policy" });
  }
  if (env.ALLOW_LOCAL_BOOTSTRAP && ![31337, 1337].includes(env.ARC_CHAIN_ID)) ctx.addIssue({ code: "custom", path: ["ALLOW_LOCAL_BOOTSTRAP"], message: "Bootstrap is restricted to local chains" });
  if (env.AGENT_RUNTIME_ENABLED && env.PAYMENT_MODE === "mock" && (env.ARC_CHAIN_ID !== 31337 || !env.ALLOW_LOCAL_BOOTSTRAP)) {
    ctx.addIssue({ code: "custom", path: ["AGENT_RUNTIME_ENABLED"], message: "Agent mock payments require explicit bootstrap on local chain 31337" });
  }
  if (env.PAYMENT_MODE === "authorized") {
    for (const field of ["USDC_ADDRESS", "USAGE_METER_ADDRESS"] as const) {
      if (!isConfiguredAddress(env[field])) ctx.addIssue({ code: "custom", path: [field], message: "Authorized payments require a configured token and usage meter" });
    }
  }
  if (env.INFERENCE_BACKEND === "openai-compatible") {
    try {
      // Construction validates transport settings without making a network request.
      createOpenAICompatibleInference({ baseUrl: env.INFERENCE_BASE_URL, model: env.INFERENCE_MODEL,
        allowRemote: env.INFERENCE_ALLOW_REMOTE, timeoutMs: env.INFERENCE_TIMEOUT_MS,
        ...(env.INFERENCE_API_KEY !== undefined ? { apiKey: env.INFERENCE_API_KEY } : {}),
        ...(env.INFERENCE_HEALTH_PATH !== undefined ? { healthPath: env.INFERENCE_HEALTH_PATH } : {}),
      });
    } catch (error) {
      ctx.addIssue({ code: "custom", path: ["INFERENCE_BACKEND"], message: error instanceof Error ? error.message : "Invalid inference configuration" });
    }
  }
  if (env.INFERENCE_BACKEND === "near-verified") {
    try { nvidiaVerifierOptions(env); }
    catch { ctx.addIssue({ code: "custom", path: ["NVIDIA_VERIFIER_MODE"], message: "NVIDIA verifier mode and artifact paths must be explicit and valid" }); }
    try { nearBaseUrl(env.INFERENCE_BASE_URL); }
    catch { ctx.addIssue({ code: "custom", path: ["INFERENCE_BASE_URL"], message: "NEAR requires an approved HTTPS endpoint" }); }
    if (!env.INFERENCE_ALLOW_REMOTE) ctx.addIssue({ code: "custom", path: ["INFERENCE_ALLOW_REMOTE"], message: "NEAR requires explicit remote inference opt-in" });
    if (!env.INFERENCE_API_KEY?.trim() || /[\r\n]/.test(env.INFERENCE_API_KEY)) ctx.addIssue({ code: "custom", path: ["INFERENCE_API_KEY"], message: "NEAR API key is required" });
    for (const field of ["NEAR_VERIFIER_PYTHON", "NEAR_ATTESTATION_POLICY"] as const) {
      if (!env[field]) ctx.addIssue({ code: "custom", path: [field], message: "NEAR hardware verifier runtime and versioned policy are required" });
    }
    if (env.INFERENCE_HEALTH_PATH) ctx.addIssue({ code: "custom", path: ["INFERENCE_HEALTH_PATH"], message: "NEAR verifies attestation before inference; clear the Modal health path" });
  }
  if (env.NVIDIA_VERIFIER_MODE === "local" && env.INFERENCE_BACKEND !== "near-verified") {
    ctx.addIssue({ code: "custom", path: ["NVIDIA_VERIFIER_MODE"], message: "Local NVIDIA verification requires verified NEAR inference" });
  }
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(withRelayKey(env));
  if (!parsed.success) {
    throw new Error(`Invalid env: ${parsed.error.message}`);
  }
  return { ...parsed.data, ARC_RPC_MAX_RPS: parsed.data.ARC_RPC_MAX_RPS ?? ([31337, 1337].includes(parsed.data.ARC_CHAIN_ID) ? 20 : 2) };
}
