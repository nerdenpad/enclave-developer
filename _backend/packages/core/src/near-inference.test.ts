import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "./errors.js";
import { sha256Hex } from "./hash.js";
import { createNearInference, verifyNearTranscript, type NearAttestationVerifier, type NearInferenceEvidence, type NearInferenceOptions, type NearVerifiedFetch, type NearVerifiedSession } from "./near-inference.js";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);
const model = "Qwen/Test-Model";
const secret = "never-log-this-api-key";
const baseUrl = "https://test-model.completions.near.ai/v1";
const attestationRef = `0x${"aa".repeat(32)}` as const;
const completion = { id: "chat_123-abc", model, choices: [{ message: { content: "Verified answer 🔐" } }] };
const rawResponse = ` ${JSON.stringify(completion)}\n`;
const transport = vi.fn<NearVerifiedFetch>();
const verify = vi.fn<NearAttestationVerifier>();
const close = vi.fn<() => void>();
let session: NearVerifiedSession;
let requestBody: string;
let signedResponse: string;

const settings: NearInferenceOptions = { baseUrl, apiKey: secret, model, verifyAttestation: verify, signatureRetryDelayMs: 1 };

async function signatureResponse(overrides: Record<string, unknown> = {}, account = signer): Promise<Response> {
  const text = `${model}:${sha256Hex(requestBody).slice(2)}:${sha256Hex(signedResponse).slice(2)}`;
  return Response.json({ text, signature: await account.signMessage({ message: text }), signing_address: account.address, signing_algo: "ecdsa", ...overrides });
}

beforeEach(() => {
  requestBody = "";
  signedResponse = rawResponse;
  close.mockReset();
  transport.mockReset().mockImplementation(async (_url, init) => {
    if (init.method === "POST") { requestBody = init.body as string; return new Response(signedResponse); }
    return signatureResponse();
  });
  session = { allowedSigners: [signer.address], attestationRef, verifiedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(), tlsBound: true, fetch: transport, close, attestationProof: '{"hardware":"evidence"}' };
  verify.mockReset().mockImplementation(async () => session);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unpinned fetch must not run"); }));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("verified direct NEAR inference", () => {
  it("attests before sending the prompt and verifies exact bytes, signature and signer", async () => {
    const result = await createNearInference(settings)(Buffer.from("Private question 🔐"));
    expect(verify).toHaveBeenCalledOnce();
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]!);
    expect(verify.mock.calls[0]![0]).toMatchObject({ baseUrl, model });
    const [postUrl, post] = transport.mock.calls[0]!;
    expect(postUrl.href).toBe(`${baseUrl}/chat/completions`);
    expect(post).toMatchObject({ method: "POST", redirect: "error", headers: { authorization: `Bearer ${secret}`, "accept-encoding": "identity" } });
    expect(JSON.parse(post.body as string)).toEqual({ model, user: expect.stringMatching(/^enclave-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), messages: [{ role: "user", content: "Private question 🔐" }], stream: false, temperature: 0, max_tokens: 1024, chat_template_kwargs: { enable_thinking: false } });
    expect(transport.mock.calls[1]![0].href).toBe(`${baseUrl}/signature/chat_123-abc?signing_algo=ecdsa`);
    expect(transport.mock.calls[1]![1]).toMatchObject({ method: "GET", redirect: "error", signal: post.signal });
    expect(verify.mock.calls[0]![0].signal).toBe(post.signal);
    expect(result.output.toString()).toBe(completion.choices[0]!.message.content);
    expect(result.transcript).toEqual({ requestBody: Buffer.from(requestBody), responseBody: Buffer.from(rawResponse), attestationProof: session.attestationProof });
    expect(result.evidence).toMatchObject({ schemaVersion: 1, provider: "near", signatureKind: "provider_tee", endpoint: new URL(baseUrl).origin,
      model, completionId: completion.id, requestHash: sha256Hex(requestBody), responseHash: sha256Hex(rawResponse), outputHash: sha256Hex(result.output),
      signingAddress: signer.address, attestationRef, verifiedAt: session.verifiedAt, expiresAt: session.expiresAt, tlsBound: true });
    expect(result.evidence.responseHash).not.toBe(sha256Hex(JSON.stringify(completion)));
    expect(JSON.stringify(result.evidence)).not.toContain(secret);
    expect(JSON.stringify(result.evidence)).not.toContain("Private question");
    expect(JSON.stringify(result.evidence)).not.toContain("Verified answer");
    expect(close).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a verified session without a serialized proof or close hook", async () => {
    delete session.attestationProof;
    delete session.close;
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    expect(result.transcript).not.toHaveProperty("attestationProof");
  });

  it("gives identical prompts distinct signed request hashes without adding identity data", async () => {
    const infer = createNearInference(settings);
    const first = await infer(Buffer.from("same private prompt"));
    const second = await infer(Buffer.from("same private prompt"));
    const firstRequest = JSON.parse(first.transcript.requestBody.toString("utf8"));
    const secondRequest = JSON.parse(second.transcript.requestBody.toString("utf8"));
    expect(firstRequest.user).toMatch(/^enclave-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(secondRequest.user).not.toBe(firstRequest.user);
    expect({ ...firstRequest, user: undefined }).toEqual({ ...secondRequest, user: undefined });
    expect(first.evidence.requestHash).not.toBe(second.evidence.requestHash);
    expect(first.evidence.responseHash).toBe(second.evidence.responseHash);
    expect(first.evidence.signature).not.toBe(second.evidence.signature);
    expect(await verifyNearTranscript(first.evidence, first.transcript)).toBe(true);
    expect(await verifyNearTranscript(second.evidence, second.transcript)).toBe(true);
  });

  it("rejects an old signature for a new identical prompt even when the response bytes match", async () => {
    const infer = createNearInference(settings);
    const first = await infer(Buffer.from("same prompt"));
    transport.mockImplementation(async (_url, init) => {
      if (init.method === "POST") { requestBody = init.body as string; return new Response(rawResponse); }
      return Response.json({ text: first.evidence.signatureText, signature: first.evidence.signature,
        signing_address: first.evidence.signingAddress, signing_algo: "ecdsa" });
    });
    await expect(infer(Buffer.from("same prompt"))).rejects.toThrow("does not bind this inference");
    expect(sha256Hex(requestBody)).not.toBe(first.evidence.requestHash);
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET", "POST", "GET"]);
  });

  it("rejects a replayed signature even if its unsigned text is changed to the fresh request hash", async () => {
    const infer = createNearInference(settings);
    const first = await infer(Buffer.from("same prompt"));
    transport.mockImplementation(async (_url, init) => {
      if (init.method === "POST") { requestBody = init.body as string; return new Response(rawResponse); }
      return signatureResponse({ signature: first.evidence.signature });
    });
    await expect(infer(Buffer.from("same prompt"))).rejects.toThrow("signer is not attested");
  });

  it("allows explicit GLM/Qwen thinking with a configured token limit", async () => {
    await createNearInference({ ...settings, enableThinking: true, maxTokens: 512 })(Buffer.from("prompt"));
    expect(JSON.parse(requestBody)).toMatchObject({ max_tokens: 512, chat_template_kwargs: { enable_thinking: true } });
  });

  it("does not send plaintext or authentication to the verifier hook", async () => {
    await createNearInference(settings)(Buffer.from("hidden prompt"));
    expect(Object.keys(verify.mock.calls[0]![0]).sort()).toEqual(["baseUrl", "model", "signal"]);
  });

  it.each(["https://test-model.completions.near.ai", `${baseUrl}/`])("normalizes an allowed direct endpoint %s", async (url) => {
    await createNearInference({ ...settings, baseUrl: url })(Buffer.from("prompt"));
    expect(transport.mock.calls[0]![0].href).toBe(`${baseUrl}/chat/completions`);
  });

  it.each(["broken", "http://test.completions.near.ai/v1", "https://cloud-api.near.ai/v1", "https://evil.example/v1",
    "https://test.completions.near.ai.evil.example/v1", "https://user:secret@test.completions.near.ai/v1",
    `${baseUrl}?secret=x`, `${baseUrl}#fragment`, `${baseUrl}/chat/completions`, "https://test.completions.near.ai:8443/v1"])("rejects an unsafe or non-direct endpoint %#", (url) => {
    expect(() => createNearInference({ ...settings, baseUrl: url })).toThrow();
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([{ model: "" }, { model: "model:unbound" }, { model: "x".repeat(513) }, { apiKey: " " }, { apiKey: "secret\r\nheader" },
    { timeoutMs: 0 }, { timeoutMs: 300001 }, { maxRequestBytes: 1.5 }, { maxResponseBytes: Infinity }, { maxOutputBytes: -1 },
    { maxTokens: 131073 }, { maxSignatureAttempts: 11 }, { signatureRetryDelayMs: 5001 }])("rejects invalid options without exposing values %#", (options) => {
    expect(() => createNearInference({ ...settings, ...options })).toThrow(/^Invalid NEAR inference/);
  });

  it("requires an attestation hook and never silently falls back to generic inference", () => {
    expect(() => createNearInference({ ...settings, verifyAttestation: undefined as unknown as NearAttestationVerifier })).toThrow("NEAR attestation verifier is required");
  });

  it.each([Buffer.from([255]), Buffer.alloc(501, 97), Buffer.alloc(300, 0)])("rejects malformed/oversize inputs before verification %#", async (input) => {
    await expect(createNearInference({ ...settings, maxRequestBytes: 500 })(input)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(verify).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    { tlsBound: false }, { allowedSigners: [] }, { allowedSigners: ["bad"] }, { allowedSigners: [`0x${"00".repeat(20)}`] },
    { attestationRef: "bad" }, { verifiedAt: "invalid" }, { verifiedAt: new Date(Date.now() + 60_000).toISOString() },
    { expiresAt: new Date(0).toISOString() }, { fetch: undefined }, { attestationProof: "a".repeat(4_194_305) },
  ])("fails closed for incomplete, expired or unbound attestation %#", async (changes) => {
    Object.assign(session, changes);
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_VERIFICATION_FAILED" });
    expect(transport).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("redacts verifier exceptions including arbitrary AppError messages", async () => {
    verify.mockRejectedValue(new AppError("INTERNAL", `${secret} prompt leak`, 403));
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ message: "NEAR attestation or verified inference failed" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds a verifier that ignores cancellation and never sends a prompt", async () => {
    verify.mockImplementation(() => new Promise(() => {}));
    await expect(createNearInference({ ...settings, timeoutMs: 10 })(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_INFERENCE_TIMEOUT", statusCode: 504 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds a transport that ignores cancellation", async () => {
    transport.mockImplementation(() => new Promise(() => {}));
    await expect(createNearInference({ ...settings, timeoutMs: 10 })(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_INFERENCE_TIMEOUT" });
    expect(transport).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([303, 401, 429, 500, 503])("never retries inference HTTP %s or leaks its response body", async (status) => {
    transport.mockResolvedValue(new Response(secret, { status }));
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ message: `NEAR inference returned HTTP ${status}` });
    expect(transport).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["redirected", "foreign-origin"])("rejects transport contract violation %s", async (kind) => {
    const response = new Response(rawResponse);
    Object.defineProperty(response, kind === "redirected" ? "redirected" : "url", { value: kind === "redirected" ? true : "https://attacker.example/" });
    transport.mockResolvedValue(response);
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toThrow("transport binding failed");
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(["not json", JSON.stringify({ ...completion, model: "other-model" }), JSON.stringify({ ...completion, id: "../escape" }),
    JSON.stringify({ ...completion, id: "" }), JSON.stringify({ ...completion, choices: [] }), JSON.stringify({ ...completion, choices: [{ message: { content: "" } }] })])("rejects malformed completion before signature lookup %#", async (body) => {
    transport.mockResolvedValue(new Response(body));
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_VERIFICATION_FAILED" });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(["declared", "stream", "invalid-length"])("bounds raw response bytes (%s)", async (mode) => {
    transport.mockResolvedValue(new Response(rawResponse, { headers: mode === "declared" ? { "content-length": "9999" } : mode === "invalid-length" ? { "content-length": "no" } : {} }));
    await expect(createNearInference({ ...settings, maxResponseBytes: 30 })(Buffer.from("prompt"))).rejects.toThrow("byte limit");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("bounds extracted UTF-8 output separately", async () => {
    await expect(createNearInference({ ...settings, maxOutputBytes: 5 })(Buffer.from("prompt"))).rejects.toThrow("output exceeds");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("bounds an indefinitely streaming response", async () => {
    transport.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([32])); } })));
    await expect(createNearInference({ ...settings, timeoutMs: 10 })(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_INFERENCE_TIMEOUT" });
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([404, 503, 504])("retries a transient signature HTTP %s without repeating the prompt", async (status) => {
    transport.mockImplementation(async (_url, init) => {
      if (init.method === "POST") { requestBody = init.body as string; return new Response(rawResponse); }
      return transport.mock.calls.length === 2 ? new Response("pending", { status }) : signatureResponse();
    });
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    expect(result.evidence.signingAddress).toBe(signer.address);
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("stops pending signature lookup after a bounded number of attempts", async () => {
    transport.mockImplementation(async (_url, init) => init.method === "POST" ? new Response(rawResponse) : new Response("not found", { status: 404 }));
    await expect(createNearInference({ ...settings, maxSignatureAttempts: 2 })(Buffer.from("prompt"))).rejects.toThrow("retry limit");
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET", "GET"]);
  });

  it("uses the total deadline for signature retry waits", async () => {
    transport.mockImplementation(async (_url, init) => init.method === "POST" ? new Response(rawResponse) : new Response("not found", { status: 404 }));
    await expect(createNearInference({ ...settings, timeoutMs: 20, signatureRetryDelayMs: 100 })(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_INFERENCE_TIMEOUT" });
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET"]);
  });

  it.each([303, 400, 401, 403, 500])("does not retry signature HTTP %s", async (status) => {
    transport.mockImplementation(async (_url, init) => init.method === "POST" ? new Response(rawResponse) : new Response(secret, { status }));
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toThrow(`signature returned HTTP ${status}`);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["different-input", "different-response", "different-model", "gateway-kind", "ed25519", "reported-signer", "unattested-signer", "invalid-signature", "high-s", "wrong-v"])("rejects proof tampering: %s", async (kind) => {
    transport.mockImplementation(async (_url, init) => {
      if (init.method === "POST") { requestBody = init.body as string; return new Response(rawResponse); }
      const overrides: Record<string, unknown> = {};
      if (kind === "different-input") requestBody += " ";
      if (kind === "different-response") signedResponse += " ";
      if (kind === "different-model") overrides.text = `Other/Model:${sha256Hex(requestBody).slice(2)}:${sha256Hex(signedResponse).slice(2)}`;
      if (kind === "gateway-kind") overrides.signature_kind = "gateway";
      if (kind === "ed25519") overrides.signing_algo = "ed25519";
      if (kind === "reported-signer") overrides.signing_address = other.address;
      if (kind === "invalid-signature") overrides.signature = `0x${"00".repeat(65)}`;
      if (kind === "high-s") overrides.signature = `0x${"11".repeat(32)}${"ff".repeat(32)}1b`;
      if (kind === "wrong-v") overrides.signature = `0x${"11".repeat(64)}09`;
      return signatureResponse(overrides, kind === "unattested-signer" ? other : signer);
    });
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ code: "NEAR_VERIFICATION_FAILED" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects attestation that expires while the completion is running", async () => {
    transport.mockImplementation(async () => { session.expiresAt = new Date(0).toISOString(); return new Response(rawResponse); });
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toThrow("expired");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects attestation that expires during signature verification", async () => {
    transport.mockImplementation(async (_url, init) => {
      if (init.method === "POST") { requestBody = init.body as string; return new Response(rawResponse); }
      session.expiresAt = new Date(0).toISOString();
      return signatureResponse();
    });
    await expect(createNearInference(settings)(Buffer.from("prompt"))).rejects.toThrow("expired");
  });

  it("redacts transport and cleanup errors", async () => {
    transport.mockRejectedValue(new AppError("INTERNAL", `${secret} prompt leak`, 500));
    close.mockImplementation(() => { throw new Error(secret); });
    const error: unknown = await createNearInference(settings)(Buffer.from("prompt")).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "NEAR attestation or verified inference failed" });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

describe("independent NEAR transcript consistency verification", () => {
  it("verifies byte-exact transcript and signature without contacting a provider", async () => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    verify.mockClear();
    transport.mockClear();
    expect(await verifyNearTranscript(result.evidence, result.transcript)).toBe(true);
    expect(verify).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["request", "response", "reformatted-response"])("rejects changed transcript %s", async (part) => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    const transcript = { ...result.transcript };
    if (part === "request") transcript.requestBody = Buffer.concat([transcript.requestBody, Buffer.from(" ")]);
    else if (part === "response") transcript.responseBody = Buffer.concat([transcript.responseBody, Buffer.from(" ")]);
    else transcript.responseBody = Buffer.from(JSON.stringify(completion));
    expect(await verifyNearTranscript(result.evidence, transcript)).toBe(false);
  });

  it.each([
    { schemaVersion: 2 }, { provider: "other" }, { signatureKind: "gateway" }, { tlsBound: false },
    { endpoint: "https://cloud-api.near.ai" }, { model: "Other/Model" }, { completionId: "other" },
    { requestHash: attestationRef }, { responseHash: attestationRef }, { outputHash: attestationRef },
    { signatureText: "different" }, { signingAddress: other.address }, { signature: "0x00" },
    { attestationRef: "bad" }, { verifiedAt: "bad" }, { expiresAt: "bad" },
  ])("rejects inconsistent evidence %#", async (changes) => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    expect(await verifyNearTranscript({ ...result.evidence, ...changes } as NearInferenceEvidence, result.transcript)).toBe(false);
  });

  it("does not confuse valid historical signatures with currently valid hardware attestation", async () => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    // Hardware and time-policy verification are a separate caller responsibility.
    const historical = { ...result.evidence, verifiedAt: new Date(0).toISOString(), expiresAt: new Date(1).toISOString() };
    expect(await verifyNearTranscript(historical, result.transcript)).toBe(true);
  });

  it("rejects recomputed hashes for a changed response even if content is unchanged", async () => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    const responseBody = Buffer.concat([result.transcript.responseBody, Buffer.from(" ")]);
    const responseHash = sha256Hex(responseBody);
    const evidence = { ...result.evidence, responseHash, signatureText: `${model}:${result.evidence.requestHash.slice(2)}:${responseHash.slice(2)}` };
    expect(await verifyNearTranscript(evidence, { ...result.transcript, responseBody })).toBe(false);
  });

  it("rejects signed response text that does not match the claimed output hash", async () => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    const responseBody = Buffer.from(JSON.stringify({ ...completion, choices: [{ message: { content: "Different output" } }] }));
    const responseHash = sha256Hex(responseBody);
    const signatureText = `${model}:${result.evidence.requestHash.slice(2)}:${responseHash.slice(2)}`;
    const evidence = { ...result.evidence, responseHash, signatureText, signature: await signer.signMessage({ message: signatureText }) };
    expect(await verifyNearTranscript(evidence, { ...result.transcript, responseBody })).toBe(false);
  });

  it("returns false for malformed external values and oversized transcripts", async () => {
    const result = await createNearInference(settings)(Buffer.from("prompt"));
    expect(await verifyNearTranscript(null as unknown as NearInferenceEvidence, result.transcript)).toBe(false);
    expect(await verifyNearTranscript(result.evidence, { requestBody: Buffer.alloc(16_777_217), responseBody: result.transcript.responseBody })).toBe(false);
  });
});
