import { sha256Hex } from "./hash.js";
import { ModelNotApprovedError } from "./errors.js";

export type AgentPolicy = {
  dailyLimitUnits: bigint;
  allowedModels: string[];
};

export function hashAgentPolicy(policy: AgentPolicy): `0x${string}` {
  const models = [...policy.allowedModels].map((m) => m.toLowerCase()).sort().join(",");
  return sha256Hex(`agent-policy:v1:${policy.dailyLimitUnits.toString()}:${models}`);
}

export function agentAllowsModel(policy: AgentPolicy, modelHash: string): boolean {
  if (policy.allowedModels.length === 0) {
    return true;
  }
  const needle = modelHash.toLowerCase();
  return policy.allowedModels.some((item) => item.toLowerCase() === needle);
}

export function assertAgentModel(policy: AgentPolicy, modelHash: string): void {
  if (!agentAllowsModel(policy, modelHash)) {
    throw new ModelNotApprovedError("Agent mandate does not allow this model");
  }
}

export function publicAgentRecord<T extends { sealedMemory?: unknown; memoryPlaintext?: unknown }>(row: T): Omit<T, "memoryPlaintext"> {
  const { memoryPlaintext: _hidden, ...rest } = row;
  return rest;
}
