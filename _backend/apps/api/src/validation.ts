import { z } from "zod";
import { isConfiguredAddress } from "@enclave/core";

export const QuoteBody = z.object({
  cpuQuote: z.string(),
  gpuQuote: z.string(),
  measurement: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  tcbVersion: z.number().int(),
  timestamp: z.number().int(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export const InferBody = z.object({
  sessionId: z.string().uuid(),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string().min(1),
  paymentId: z.string().uuid().optional(),
  agentId: z.string().uuid().optional(),
});

export const SettleBody = z.object({
  paymentId: z.string().uuid(),
  confidential: z.boolean().optional(),
  authorization: z.object({
    from: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((v) => v as `0x${string}`),
    validAfter: z.string().regex(/^\d{1,78}$/),
    validBefore: z.string().regex(/^\d{1,78}$/),
    signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/).transform((v) => v as `0x${string}`),
  }).optional(),
});

export const AgentBody = z.object({
  name: z.string().min(1).max(80),
  dailyLimitUsdc: z.number().positive(),
  allowedModels: z.array(z.string()).optional(),
  sessionId: z.string().uuid().optional(),
  iv: z.string().optional(),
  tag: z.string().optional(),
  ciphertext: z.string().optional(),
}).superRefine((value, ctx) => {
  const fields = [value.iv, value.tag, value.ciphertext];
  if (fields.some((field) => field !== undefined) && (!value.sessionId || fields.some((field) => !field))) {
    ctx.addIssue({ code: "custom", message: "Memory requires sessionId, iv, tag and ciphertext" });
  }
});

export const MemoryBody = z.object({
  sessionId: z.string().uuid(),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ciphertext: z.string().min(1),
});

export const StakeBody = z.object({
  amountWei: z.string().regex(/^\d+$/),
});

export const ListModelBody = z.object({
  modelHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  codeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  version: z.string().min(1),
  bps: z.number().int().min(0).max(10_000).default(0),
  policyHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).optional(),
  policyVersion: z.number().int().min(1).max(2_147_483_647).optional(),
}).superRefine((value, ctx) => {
  if ((value.policyHash === undefined) !== (value.policyVersion === undefined)) {
    ctx.addIssue({ code: "custom", message: "policyHash and policyVersion must be supplied together" });
  }
});

export const ViewKeyBody = z.object({
  label: z.string().min(1).max(80),
});

export const TcbRotateBody = z.object({
  servingImageId: z.string().min(1).max(80).refine((value) => Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value)),
  version: z.number().int().min(1).max(2_147_483_647).optional(),
}).strict();

export const AgentSdkInvokeBody = z.object({
  tool: z.string().min(1),
  input: z.record(z.unknown()).default({}),
});

const ContractAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/).refine(isConfiguredAddress, "A configured non-placeholder address is required");
const PositiveUint256 = z.string().regex(/^\d{1,78}$/).refine((value) => {
  if (!/^\d{1,78}$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed > 0n && parsed <= (1n << 256n) - 1n;
}, "Expected a positive uint256 integer");

export const BuybackConfigBody = z.object({ router: ContractAddress, tokenOut: ContractAddress, recipient: ContractAddress });
export const BuybackReserveBody = z.object({ treasuryBps: z.number().int().min(0).max(1000) });
export const BuybackExecuteBody = z.object({ amountUnits: PositiveUint256, minOut: PositiveUint256, deadline: PositiveUint256 });
