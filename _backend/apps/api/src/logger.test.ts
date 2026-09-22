import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("logger redact", () => {
  it("redacts agent goals, credentials, signed authorizations and persisted state", async () => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    createLogger("info", stream).info({ goal: "private-agent-objective", apiKey: "owner-credential",
      hostSecret: "host-encryption-material", nested: { authorization: "signed-spend", sealedState: "state-cipher", sealedPayload: "action-cipher" } }, "agent_event");
    await new Promise((resolve) => setImmediate(resolve));
    const line = Buffer.concat(chunks).toString("utf8");
    for (const secret of ["private-agent-objective", "owner-credential", "host-encryption-material", "signed-spend", "state-cipher", "action-cipher"]) expect(line).not.toContain(secret);
    expect(JSON.parse(line).goal).toBe("[redacted]");
  });
  it("strips prompt, wrapKey, wrappingKey, and enclave private key material", async () => {
    const chunks: Buffer[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    const log = createLogger("info", stream);
    log.info(
      {
        prompt: "do not log me",
        wrapKey: "session-aes",
        wrappingKey: "0xdead",
        nested: { enclavePrivateKey: "0xabc", modelKey: "0xdef" },
      },
      "should_redact",
    );
    await new Promise((resolve) => setImmediate(resolve));
    const line = Buffer.concat(chunks).toString("utf8");
    expect(line).toContain("[redacted]");
    expect(line).not.toContain("do not log me");
    expect(line).not.toContain("session-aes");
    expect(line).not.toContain("0xdead");
    expect(line).not.toContain("0xabc");
    expect(line).not.toContain("0xdef");
  });
});
