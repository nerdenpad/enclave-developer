export type AgentSdkTool = {
  name: "enclave_quote" | "enclave_session" | "enclave_infer" | "enclave_settle";
  description: string;
  input_schema: Record<string, unknown>;
};

export const ENCLAVE_AGENT_TOOLS: AgentSdkTool[] = [
  {
    name: "enclave_quote",
    description: "Fetch a signed software quote for a development session; hardware CPU/GPU attestation is unavailable.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "enclave_session",
    description: "Verify a development software quote and open an inference session. Returns wrapKey for AES-GCM prompts and encrypted responses.",
    input_schema: {
      type: "object",
      required: ["cpuQuote", "gpuQuote", "measurement", "tcbVersion", "timestamp", "signature"],
      properties: {
        cpuQuote: { type: "string" },
        gpuQuote: { type: "string" },
        measurement: { type: "string" },
        tcbVersion: { type: "integer" },
        timestamp: { type: "integer" },
        signature: { type: "string" },
      },
    },
  },
  {
    name: "enclave_infer",
    description: "Run inference in the development software CVM on an AES-GCM prompt. Returns encrypted output and a signed receipt. Unpaid calls return HTTP 402 x402.",
    input_schema: {
      type: "object",
      required: ["sessionId", "iv", "tag", "ciphertext"],
      properties: {
        sessionId: { type: "string" },
        iv: { type: "string" },
        tag: { type: "string" },
        ciphertext: { type: "string" },
        paymentId: { type: "string" },
        agentId: { type: "string" },
      },
    },
  },
  {
    name: "enclave_settle",
    description: "Settle a USDC x402 payment. Authorized mode requires a payer-signed ERC-3009 ReceiveWithAuthorization: sign the typed data from GET /v1/payments/{paymentId}/authorization?from={payer} and pass authorization. The optional confidential mock is restricted to local development chains.",
    input_schema: {
      type: "object",
      required: ["paymentId"],
      properties: {
        paymentId: { type: "string", format: "uuid" },
        confidential: { type: "boolean" },
        authorization: {
          type: "object",
          required: ["from", "validAfter", "validBefore", "signature"],
          properties: {
            from: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            validAfter: { type: "string", pattern: "^\\d{1,78}$" },
            validBefore: { type: "string", pattern: "^\\d{1,78}$" },
            signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
          },
        },
      },
    },
  },
];

export function agentSdkManifest() {
  return {
    name: "enclave",
    version: "1",
    tools: ENCLAVE_AGENT_TOOLS,
  };
}

export function isAgentSdkTool(name: string): name is AgentSdkTool["name"] {
  return ENCLAVE_AGENT_TOOLS.some((tool) => tool.name === name);
}
