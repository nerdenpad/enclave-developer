import { createServer } from "node:http";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEnclaveMcpServer, ENCLAVE_MCP_TOOL_NAMES, type EnclaveMcpOptions } from "./index.js";

const apiKey = "host-api-key-CANARY-never-in-MCP";
const wrapKey = Buffer.alloc(32, 91).toString("base64");
const sessionId = "13e4fbe5-ab72-48e9-a10f-c5b9c3ce30fb";
const paymentId = "48d65cd8-c73b-4f65-9537-8d1c30a1aa68";
const hex = `0x${"aa".repeat(32)}`;
const sig = `0x${"11".repeat(65)}`;
const payer = `0x${"22".repeat(20)}`;
const blob = { iv: Buffer.alloc(12, 1).toString("base64"), tag: Buffer.alloc(16, 2).toString("base64"), ciphertext: Buffer.from("ENCRYPTED-NOT-A-PROMPT").toString("base64") };
const quote = { cpuQuote: "tdx:development", gpuQuote: "nvidia-cc:development", measurement: hex, tcbVersion: 1, timestamp: 1789835832000, signature: sig };
const session = { sessionId, expiresAt: "2026-09-19T20:00:00.000Z", wrapKey };
const receipt = { receiptVersion: 2, modelHash: hex, codeHash: hex, inHash: hex, outHash: hex, attRef: hex, nonce: hex, ts: "1789835832", sig };
const proof = { version: 1, receiptHash: hex, evidenceHash: hex, sig,
  evidence: { schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: "https://glm.completions.near.ai",
    model: "glm", completionId: "chatcmpl-123", requestHash: hex, responseHash: hex, outputHash: hex,
    signatureText: `glm:${hex.slice(2)}:${hex.slice(2)}`, signature: sig, signingAddress: payer, attestationRef: hex,
    verifiedAt: "2026-09-19T19:59:00.000Z", expiresAt: "2026-09-19T20:00:00.000Z", tlsBound: true } };
const inference = { receipt, typedHash: hex, outputHash: hex, output: blob,
  providerEvidence: { proof, transcript: blob } };
const settlement = { paymentId, tx: hex, confidential: false };
const payment = { x402Version: 1, accepts: [{ scheme: "exact", network: "arc-31337", maxAmountRequired: "1000", payTo: payer, asset: payer, extra: { receiptPending: true, paymentId } }] };
const fetchMock = vi.fn<typeof fetch>();
const close: (() => Promise<void>)[] = [];
const defaults: EnclaveMcpOptions = { baseUrl: "https://gateway.example", apiKey };

async function connect(options: Partial<EnclaveMcpOptions> = {}) {
  const sdkServer = createEnclaveMcpServer({ ...defaults, ...options });
  const client = new Client({ name: "enclave-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await sdkServer.instance.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(async () => { await client.close(); await sdkServer.instance.close(); });
  return client;
}

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    return Response.json(path.endsWith("quote") ? quote : path.endsWith("session") ? session : path.endsWith("settle") ? settlement : inference);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  await Promise.all(close.splice(0).map((cleanup) => cleanup()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("real Claude Agent SDK MCP transport", () => {
  it("initializes a real SDK server and lists exactly four strict tools", async () => {
    const client = await connect();
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(ENCLAVE_MCP_TOOL_NAMES);
    for (const tool of result.tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(JSON.stringify(tool)).not.toContain(apiKey);
    }
    expect(result.tools[0]!.annotations?.readOnlyHint).toBe(true);
    expect(result.tools[3]!.annotations?.destructiveHint).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches the development quote with authentication confined to a fixed-origin header", async () => {
    const result = await (await connect()).callTool({ name: "enclave_quote", arguments: {} });
    expect(result.structuredContent).toEqual(quote);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://gateway.example/v1/attestation/quote");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: "GET", redirect: "error", headers: { "x-api-key": apiKey } });
    expect(fetchMock.mock.calls[0]![1]).not.toHaveProperty("body");
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("keeps the session wrapKey only in a trusted host callback", async () => {
    const onSession = vi.fn();
    const result = await (await connect({ onSession })).callTool({ name: "enclave_session", arguments: quote });
    expect(onSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(result.structuredContent).toEqual({ sessionId, expiresAt: session.expiresAt });
    expect(JSON.stringify(result)).not.toContain(wrapKey);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual(quote);
  });

  it("refuses session creation before HTTP when the host cannot receive wrapping keys", async () => {
    const result = await (await connect()).callTool({ name: "enclave_session", arguments: quote });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "SESSION_HANDLER_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redacts callback exceptions containing credentials and wrapping keys", async () => {
    const result = await (await connect({ onSession: () => { throw new Error(`${apiKey} ${wrapKey} private-prompt-CANARY`); } }))
      .callTool({ name: "enclave_session", arguments: quote });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_REQUEST_FAILED" });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|private-prompt/);
    expect(JSON.stringify(result)).not.toContain(wrapKey);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds a host callback that ignores cancellation", async () => {
    const result = await (await connect({ timeoutMs: 10, onSession: () => new Promise(() => {}) }))
      .callTool({ name: "enclave_session", arguments: quote });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_TIMEOUT" });
  });

  it("preserves encrypted input/output/proof and sends the idempotency key only as a header", async () => {
    const input = { sessionId, ...blob, paymentId, agentId: sessionId, idempotencyKey: "encrypted-call-1" };
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: input });
    expect(result.structuredContent).toEqual(inference);
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://gateway.example/v1/inference");
    expect(call[1]?.headers).toMatchObject({ "idempotency-key": "encrypted-call-1" });
    const { idempotencyKey: _, ...expected } = input;
    expect(JSON.parse(call[1]!.body as string)).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it("accepts a larger encrypted hardware transcript and strips unknown gateway fields", async () => {
    const transcript = { ...blob, ciphertext: Buffer.alloc(1_048_579, 7).toString("base64") };
    fetchMock.mockResolvedValue(Response.json({ ...inference, secret: apiKey,
      providerEvidence: { transcript, extra: apiKey, proof: { ...proof, debug: apiKey,
        evidence: { ...proof.evidence, privatePrompt: "plaintext-CANARY" } } } }));
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: { sessionId, ...blob } });
    expect(result.structuredContent).toEqual({ ...inference, providerEvidence: { proof, transcript } });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("rejects a malformed provider proof instead of presenting it as evidence", async () => {
    fetchMock.mockResolvedValue(Response.json({ ...inference,
      providerEvidence: { ...inference.providerEvidence, proof: { ...proof, sig: "untrusted" } } }));
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: { sessionId, ...blob } });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_RESPONSE_INVALID" });
  });

  it("rejects a v2 receipt missing its replay-protection nonce", async () => {
    const { nonce: _, ...withoutNonce } = receipt;
    fetchMock.mockResolvedValue(Response.json({ ...inference, receipt: withoutNonce }));
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: { sessionId, ...blob } });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_RESPONSE_INVALID" });
  });

  it("accepts a historical v1 receipt without adding a nonce or provider proof", async () => {
    const { nonce: _, ...withoutNonce } = receipt;
    const { providerEvidence: __, ...withoutProof } = inference;
    const response = { ...withoutProof, receipt: { ...withoutNonce, receiptVersion: 1 } };
    fetchMock.mockResolvedValue(Response.json(response));
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: { sessionId, ...blob } });
    expect(result.structuredContent).toEqual(response);
  });

  it("rejects JSON escape expansion beyond the request byte cap before HTTP", async () => {
    const result = await (await connect({ onSession: vi.fn() })).callTool({ name: "enclave_session",
      arguments: { ...quote, gpuQuote: "\u0000".repeat(400_000) } });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_REQUEST_TOO_LARGE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([1_048_577, 1_048_578])("rejects %s decoded ciphertext bytes despite base64 length rounding", async (bytes) => {
    const result = await (await connect()).callTool({ name: "enclave_infer",
      arguments: { sessionId, ...blob, ciphertext: Buffer.alloc(bytes).toString("base64") } });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts exactly the ciphertext byte limit", async () => {
    const ciphertext = Buffer.alloc(1_048_576).toString("base64");
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: { sessionId, ...blob, ciphertext } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).ciphertext).toBe(ciphertext);
  });

  it("forwards externally signed authorization unchanged and never signs it", async () => {
    const authorization = { from: payer, validAfter: "0", validBefore: "9999999999", signature: sig };
    const input = { paymentId, confidential: false, authorization };
    const result = await (await connect()).callTool({ name: "enclave_settle", arguments: input });
    expect(result.structuredContent).toEqual(settlement);
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://gateway.example/v1/x402/settle");
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toEqual(input);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a validated payment challenge without echoing the gateway's error detail", async () => {
    fetchMock.mockResolvedValue(Response.json({ status: 402, title: "PAYMENT_REQUIRED", details: payment,
      detail: `private-prompt ${apiKey}`, untrusted: "ignored" }, { status: 402 }));
    const result = await (await connect()).callTool({ name: "enclave_infer", arguments: { sessionId, ...blob } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ error: "PAYMENT_REQUIRED", status: 402, payment });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|private-prompt/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["enclave_quote", { apiKey }],
    ["enclave_session", { ...quote, prompt: "not allowed" }],
    ["enclave_infer", { sessionId, ...blob, baseUrl: "https://attacker.invalid" }],
    ["enclave_infer", { sessionId, ...blob, ciphertext: "not base64" }],
    ["enclave_infer", { sessionId, ...blob, iv: Buffer.alloc(11).toString("base64") }],
    ["enclave_infer", { sessionId, ...blob, idempotencyKey: "key\r\ninject" }],
    ["enclave_infer", { sessionId: "invalid", ...blob }],
    ["enclave_settle", { paymentId, confidential: "false" }],
    ["enclave_settle", { paymentId, authorization: { from: payer, validAfter: "0", validBefore: "1", signature: sig, privateKey: "forbidden" } }],
    ["enclave_settle", { paymentId, authorization: { from: payer, validAfter: "0", validBefore: (1n << 256n).toString(), signature: sig } }],
    ["enclave_settle", { paymentId, authorization: { from: payer, validAfter: "abc", validBefore: "1", signature: sig } }],
  ])("rejects invalid or unknown arguments before any HTTP: %s %#", async (name, args) => {
    const result = await (await connect({ onSession: vi.fn() })).callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(apiKey);
  });

  it.each([301, 302, 307, 401, 403, 409, 429, 500, 503])("never retries or reflects HTTP %s errors", async (status) => {
    fetchMock.mockResolvedValue(new Response(`${apiKey} plaintext-CANARY`, { status }));
    const result = await (await connect()).callTool({ name: "enclave_settle", arguments: { paymentId } });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_HTTP_ERROR", status });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it.each(["redirected", "foreign-origin"])("rejects transport origin violations %s", async (kind) => {
    const response = Response.json(quote);
    Object.defineProperty(response, kind === "redirected" ? "redirected" : "url", { value: kind === "redirected" ? true : "https://attacker.invalid/" });
    fetchMock.mockResolvedValue(response);
    const result = await (await connect()).callTool({ name: "enclave_quote", arguments: {} });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_ORIGIN_MISMATCH" });
  });

  it.each(["not-json", "schema", "missing-body", "declared-large", "invalid-length", "stream-large", "bad-402"])("fails closed on malformed gateway output: %s", async (kind) => {
    let response: Response;
    if (kind === "not-json") response = new Response(`${apiKey} not JSON`);
    else if (kind === "schema") response = Response.json({ wrapKey, ...quote, signature: "bad" });
    else if (kind === "missing-body") response = new Response(null, { status: 204 });
    else if (kind === "declared-large") response = new Response("x", { headers: { "content-length": "8388609" } });
    else if (kind === "invalid-length") response = new Response("x", { headers: { "content-length": "wrong" } });
    else if (kind === "stream-large") response = new Response("x".repeat(8_388_609));
    else response = Response.json({ status: 402, title: "PAYMENT_REQUIRED", details: { secret: apiKey } }, { status: 402 });
    fetchMock.mockResolvedValue(response);
    const result = await (await connect()).callTool({ name: "enclave_quote", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain(wrapKey);
  });

  it("bounds pending HTTP and body streams even when cancellation is ignored", async () => {
    const client = await connect({ timeoutMs: 10 });
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = await client.callTool({ name: "enclave_quote", arguments: {} });
    expect(pending.structuredContent).toEqual({ error: "GATEWAY_TIMEOUT" });
    fetchMock.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([32])); } })));
    const streaming = await client.callTool({ name: "enclave_quote", arguments: {} });
    expect(streaming.structuredContent).toEqual({ error: "GATEWAY_TIMEOUT" });
  });

  it("propagates MCP caller cancellation to the HTTP request without retrying", async () => {
    const client = await connect();
    const controller = new AbortController();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const pending = client.callTool({ name: "enclave_quote", arguments: {} }, undefined, { signal: controller.signal });
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(fetchMock.mock.calls[0]![1]!.signal!.aborted).toBe(true));
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("redacts transport exceptions rather than leaking request headers or prompt text", async () => {
    fetchMock.mockRejectedValue(new Error(`${apiKey} private-prompt-CANARY`));
    const result = await (await connect()).callTool({ name: "enclave_quote", arguments: {} });
    expect(result.structuredContent).toEqual({ error: "GATEWAY_REQUEST_FAILED" });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("roundtrips through a real loopback HTTP server using the real MCP Client and SDK server", async () => {
    vi.unstubAllGlobals();
    let observed: { url?: string; key?: string; body?: string } = {};
    const http = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      observed = { url: request.url!, key: request.headers["x-api-key"] as string, body: Buffer.concat(chunks).toString("utf8") };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(inference));
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const port = (http.address() as { port: number }).port;
    try {
      const result = await (await connect({ baseUrl: `http://127.0.0.1:${port}`, allowInsecureLocalhost: true }))
        .callTool({ name: "enclave_infer", arguments: { sessionId, ...blob } });
      expect(result.structuredContent).toEqual(inference);
      expect(observed.url).toBe("/v1/inference");
      expect(observed.key).toBe(apiKey);
      expect(JSON.parse(observed.body!)).toEqual({ sessionId, ...blob });
      expect(JSON.stringify(result)).not.toContain(apiKey);
    } finally { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
  });
});

describe("trusted configuration boundary", () => {
  it.each(["no url", "http://gateway.example", "http://127.0.0.1", "file:///tmp/key", "https://user:pass@gateway.example", "https://gateway.example/v1", "https://gateway.example?key=x", "https://gateway.example#x"])("rejects unsafe origin %s", (baseUrl) => {
    expect(() => createEnclaveMcpServer({ ...defaults, baseUrl })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])("permits explicit loopback HTTP %s", async (baseUrl) => {
    const server = createEnclaveMcpServer({ ...defaults, baseUrl, allowInsecureLocalhost: true });
    await server.instance.close();
  });
  it.each(["http://127.0.0.1.attacker.invalid", "http://10.0.0.1"])("never treats non-loopback HTTP as local %s", (baseUrl) => {
    expect(() => createEnclaveMcpServer({ ...defaults, baseUrl, allowInsecureLocalhost: true })).toThrow();
  });
  it.each([{ apiKey: "" }, { apiKey: "secret\r\nheader" }, { apiKey: "contains space" }, { timeoutMs: 0 }, { timeoutMs: 300001 }, { timeoutMs: NaN }, { onSession: 1 as unknown as NonNullable<EnclaveMcpOptions["onSession"]> }])("rejects invalid private configuration %#", (changes) => {
    expect(() => createEnclaveMcpServer({ ...defaults, ...changes })).toThrow(/^Invalid Enclave/);
  });
});
