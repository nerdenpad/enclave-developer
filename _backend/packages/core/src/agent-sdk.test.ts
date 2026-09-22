import { describe, expect, it } from "vitest";
import { agentSdkManifest, isAgentSdkTool } from "./agent-sdk.js";

describe("Claude Agent SDK adapter", () => {
  it("exposes quote, session, infer, and settle tools", () => {
    const manifest = agentSdkManifest();
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "enclave_quote",
      "enclave_session",
      "enclave_infer",
      "enclave_settle",
    ]);
    expect(isAgentSdkTool("enclave_infer")).toBe(true);
    expect(isAgentSdkTool("not_a_tool")).toBe(false);
  });

  it("describes the software security boundary and encrypted inference responses", () => {
    const tools = agentSdkManifest().tools;
    for (const name of ["enclave_quote", "enclave_session", "enclave_infer"]) {
      expect(tools.find((tool) => tool.name === name)?.description).toContain("software");
    }
    expect(tools.find((tool) => tool.name === "enclave_quote")?.description).toContain("hardware CPU/GPU attestation is unavailable");
    expect(tools.find((tool) => tool.name === "enclave_infer")?.description).toContain("encrypted output");
  });

  it("advertises the complete payer authorization while preserving mock-mode inputs", () => {
    const settle = agentSdkManifest().tools.find((tool) => tool.name === "enclave_settle")!;
    expect(settle.description).toContain("ReceiveWithAuthorization");
    expect(settle.description).toContain("/v1/payments/{paymentId}/authorization?from={payer}");
    expect(settle.input_schema).toMatchObject({
      type: "object", required: ["paymentId"], properties: {
        paymentId: { type: "string", format: "uuid" }, confidential: { type: "boolean" },
        authorization: { type: "object", required: ["from", "validAfter", "validBefore", "signature"], properties: {
          from: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          validAfter: { type: "string", pattern: "^\\d{1,78}$" },
          validBefore: { type: "string", pattern: "^\\d{1,78}$" },
          signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" },
        } },
      },
    });
  });
});
