import { z } from "zod";
import { createOpenAICompatibleInference, isConfiguredAddress } from "@enclave/core";
import { nearBaseUrl } from "./near-provider.js";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://127.0.0.1:6379"),
  ARC_RPC_URL: z.string().default("http://127.0.0.1:8545"),
  ARC_CHAIN_ID: z.coerce.number().int().positive().default(31337),
  CHAIN_CONFIRMATIONS: z.coerce.number().int().min(0).max(1000).optional(),
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
  TEE_MODE: z.enum(["dev"]).default("dev"),
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
  NEAR_ATTESTATION_POLICY: z.string().min(1).optional(),
  NEAR_MAX_TOKENS: z.coerce.number().int().positive().max(4096).default(512),
  AGENT_RUNTIME_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  AGENT_RUNTIME_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(1000),
  AGENT_RUNTIME_MAX_STEPS: z.coerce.number().int().min(1).max(100).default(8),
  AGENT_RUNTIME_MAX_BUDGET_UNITS: z.coerce.number().int().positive().max(1_000_000_000_000).default(1_000_000),
  AGENT_RUNTIME_MAX_DURATION_MS: z.coerce.number().int().min(1000).max(86_400_000).default(900_000),
}).superRefine((env, ctx) => {
  const priceUnits = Math.round(env.INFERENCE_PRICE_USDC * 1_000_000);
  if (!Number.isSafeInteger(priceUnits) || priceUnits <= 0) ctx.addIssue({ code: "custom", path: ["INFERENCE_PRICE_USDC"], message: "Price must be at least one USDC unit and fit safe integer units" });
  if (env.NODE_ENV === "production") {
    ctx.addIssue({ code: "custom", path: ["TEE_MODE"], message: "Production requires a hardware TEE adapter; dev CVM is not supported" });
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
    try { nearBaseUrl(env.INFERENCE_BASE_URL); }
    catch { ctx.addIssue({ code: "custom", path: ["INFERENCE_BASE_URL"], message: "NEAR requires a direct HTTPS completions endpoint" }); }
    if (!env.INFERENCE_ALLOW_REMOTE) ctx.addIssue({ code: "custom", path: ["INFERENCE_ALLOW_REMOTE"], message: "NEAR requires explicit remote inference opt-in" });
    if (!env.INFERENCE_API_KEY?.trim() || /[\r\n]/.test(env.INFERENCE_API_KEY)) ctx.addIssue({ code: "custom", path: ["INFERENCE_API_KEY"], message: "NEAR API key is required" });
    for (const field of ["NEAR_VERIFIER_PYTHON", "NEAR_ATTESTATION_POLICY"] as const) {
      if (!env[field]) ctx.addIssue({ code: "custom", path: [field], message: "NEAR hardware verifier runtime and versioned policy are required" });
    }
    if (env.INFERENCE_HEALTH_PATH) ctx.addIssue({ code: "custom", path: ["INFERENCE_HEALTH_PATH"], message: "NEAR verifies attestation before inference; clear the Modal health path" });
  }
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid env: ${parsed.error.message}`);
  }
  return parsed.data;
}
