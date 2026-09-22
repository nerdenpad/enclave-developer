import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleInference } from "./inference.js";

const settings = { baseUrl: "http://127.0.0.1:8000/v1", model: "local-model" };
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => Response.json({ choices: [{ message: { content: "local answer" } }] }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("non-TEE OpenAI-compatible inference", () => {
  it("sends a non-streaming chat completion and returns only its UTF-8 output", async () => {
    const infer = createOpenAICompatibleInference({ ...settings, apiKey: "local-secret", maxTokens: 42 });
    expect((await infer(Buffer.from("private question 🔐"))).toString()).toBe("local answer");
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:8000/v1/chat/completions");
    expect(request?.method).toBe("POST");
    expect(request?.redirect).toBe("error");
    expect(request?.headers).toMatchObject({ authorization: "Bearer local-secret", "content-type": "application/json" });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(request?.body as string)).toEqual({
      model: "local-model", messages: [{ role: "user", content: "private question 🔐" }],
      stream: false, temperature: 0, max_tokens: 42,
    });
  });

  it.each(["http://localhost:8000", "http://127.0.0.1:8000/", "http://[::1]:8000/v1/"])("accepts local base URL %s without credentials", async (baseUrl) => {
    await createOpenAICompatibleInference({ ...settings, baseUrl })(Buffer.from("prompt"));
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe("/v1/chat/completions");
    expect(request?.headers).not.toHaveProperty("authorization");
  });

  it.each([
    "not-a-url", "file:///tmp/model", "ftp://localhost/model", "http://user:password@localhost/v1",
    "http://localhost/v1?key=secret", "http://localhost/v1#secret", "https://remote.example/v1",
  ])("rejects invalid or implicitly remote endpoint %#", (baseUrl) => {
    expect(() => createOpenAICompatibleInference({ ...settings, baseUrl })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires explicit opt-in to send prompts to a non-local server", async () => {
    await createOpenAICompatibleInference({ ...settings, baseUrl: "https://trusted.example/v1", allowRemote: true, apiKey: "remote-secret" })(Buffer.from("prompt"));
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://trusted.example/v1/chat/completions");
  });

  it("forbids remote HTTP even with explicit opt-in and authentication", () => {
    expect(() => createOpenAICompatibleInference({ ...settings, baseUrl: "http://trusted.example/v1", allowRemote: true, apiKey: "remote-secret" })).toThrow("Remote inference requires HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "   "])("requires a nonblank token for remote HTTPS %#", (apiKey) => {
    expect(() => createOpenAICompatibleInference({ ...settings, baseUrl: "https://trusted.example/v1", allowRemote: true, ...(apiKey === undefined ? {} : { apiKey }) })).toThrow("Remote inference requires an API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects header injection without exposing the key", () => {
    const key = "secret\r\nInjected: header";
    expect(() => createOpenAICompatibleInference({ ...settings, apiKey: key })).toThrow(/^Invalid inference API key$/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("authenticates mocked HTTPS requests and redacts credentials from provider and transport errors", async () => {
    const secret = "modal-bearer-secret";
    const infer = createOpenAICompatibleInference({ ...settings, baseUrl: "https://gpu.example.modal.run/v1", allowRemote: true, apiKey: secret });
    expect((await infer(Buffer.from("private prompt"))).toString()).toBe("local answer");
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://gpu.example.modal.run/v1/chat/completions");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { authorization: `Bearer ${secret}` } });
    fetchMock.mockResolvedValueOnce(new Response(`bad credential ${secret}: private prompt`, { status: 401 }));
    await expect(infer(Buffer.from("private prompt"))).rejects.toMatchObject({ message: "Inference backend returned HTTP 401", statusCode: 502 });
    fetchMock.mockRejectedValueOnce(new Error(`request with Authorization: Bearer ${secret} failed`));
    const error = await infer(Buffer.from("private prompt")).catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "Inference backend request failed", statusCode: 502 });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
  });

  it("allows a five-minute cold-start deadline without changing the default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(new AbortController().signal);
    await createOpenAICompatibleInference(settings)(Buffer.from("prompt"));
    expect(timeout).toHaveBeenLastCalledWith(30_000);
    await createOpenAICompatibleInference({ ...settings, timeoutMs: 300_000 })(Buffer.from("prompt"));
    expect(timeout).toHaveBeenLastCalledWith(300_000);
  });

  it.each([
    { model: " " }, { model: "a".repeat(513) },
    { timeoutMs: 0 }, { timeoutMs: 300_001 }, { timeoutMs: NaN },
    { maxOutputBytes: -1 }, { maxOutputBytes: 1.5 }, { maxOutputBytes: 16_777_217 },
    { maxTokens: 0 }, { maxTokens: 131_073 },
  ])("rejects invalid adapter limits %#", (options) => {
    expect(() => createOpenAICompatibleInference({ ...settings, ...options })).toThrow();
  });

  it("rejects non-UTF8 input before sending a request", async () => {
    await expect(createOpenAICompatibleInference(settings)(Buffer.from([0xff, 0xfe]))).rejects.toMatchObject({ statusCode: 400, code: "VALIDATION_FAILED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose provider response errors, prompts or credentials", async () => {
    fetchMock.mockResolvedValue(new Response("prompt and secret token", { status: 429 }));
    await expect(createOpenAICompatibleInference(settings)(Buffer.from("private"))).rejects.toMatchObject({
      code: "INFERENCE_BACKEND_FAILED", statusCode: 502, message: "Inference backend returned HTTP 429",
    });
    fetchMock.mockRejectedValue(new Error("failed URL with secret token and private prompt"));
    await expect(createOpenAICompatibleInference(settings)(Buffer.from("private"))).rejects.toMatchObject({
      code: "INFERENCE_BACKEND_FAILED", statusCode: 502, message: "Inference backend request failed",
    });
  });

  it("rejects malformed JSON without including the backend body", async () => {
    fetchMock.mockResolvedValue(new Response("secret not JSON"));
    await expect(createOpenAICompatibleInference(settings)(Buffer.from("private"))).rejects.toMatchObject({ message: "Inference backend returned invalid JSON" });
  });

  it.each([
    {}, { choices: [] }, { choices: [{ message: { content: null } }] },
    { choices: [{ message: { content: "" } }] }, { choices: [{ message: { content: { secret: "object" } } }] },
  ])("rejects invalid or missing completion content %#", async (payload) => {
    fetchMock.mockResolvedValue(Response.json(payload));
    await expect(createOpenAICompatibleInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference backend returned an invalid completion" });
  });

  it("bounds decoded output by byte count, including multi-byte characters", async () => {
    fetchMock.mockResolvedValue(Response.json({ choices: [{ message: { content: "€€" } }] }));
    await expect(createOpenAICompatibleInference({ ...settings, maxOutputBytes: 5 })(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference output exceeds configured limit" });
  });

  it("rejects an oversized declared response before consuming its contents", async () => {
    fetchMock.mockResolvedValue(new Response("private", { headers: { "content-length": "1000000" } }));
    await expect(createOpenAICompatibleInference({ ...settings, maxOutputBytes: 1 })(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference backend response is too large" });
  });

  it("bounds chunked responses even when Content-Length is absent", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(20_000)); },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(body));
    await expect(createOpenAICompatibleInference({ ...settings, maxOutputBytes: 1 })(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference backend response is too large" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a missing response body", async () => {
    fetchMock.mockResolvedValue(new Response(null));
    await expect(createOpenAICompatibleInference(settings)(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference backend returned an empty response" });
  });
});

describe("authenticated inference cold-start readiness", () => {
  const remote = { baseUrl: "https://gpu.example.modal.run/v1", model: "gpu-model", apiKey: "health-secret", allowRemote: true, healthPath: "/health" };

  it("checks the HTTPS origin health before POST using authentication and one shared deadline", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await createOpenAICompatibleInference(remote)(Buffer.from("private prompt"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [health, post] = fetchMock.mock.calls;
    expect(String(health![0])).toBe("https://gpu.example.modal.run/health");
    expect(health![1]).toMatchObject({ method: "GET", redirect: "manual", headers: { authorization: "Bearer health-secret" } });
    expect(health![1]).not.toHaveProperty("body");
    expect(String(post![0])).toBe("https://gpu.example.modal.run/v1/chat/completions");
    expect(post![1]).toMatchObject({ method: "POST", redirect: "error", signal: health![1]!.signal });
  });

  it.each([303, 502, 503, 504])("retries a health HTTP %i at the original URL before a single prompt submission", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("cold", { status, headers: { location: "https://untrusted.example/collect" } }));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const output = await createOpenAICompatibleInference(remote)(Buffer.from("private prompt"));
    expect(output.toString()).toBe("local answer");
    expect(fetchMock.mock.calls.map(([url, request]) => [String(url), request?.method])).toEqual([
      ["https://gpu.example.modal.run/health", "GET"], ["https://gpu.example.modal.run/health", "GET"],
      ["https://gpu.example.modal.run/v1/chat/completions", "POST"],
    ]);
  });

  it.each([401, 403, 404, 307, 308])("does not retry or submit a prompt after health HTTP %i", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("private provider body", { status }));
    await expect(createOpenAICompatibleInference(remote)(Buffer.from("prompt"))).rejects.toMatchObject({
      code: "INFERENCE_BACKEND_FAILED", message: `Inference health check returned HTTP ${status}`, statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts health retry sleep at the total deadline and never posts a prompt", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await expect(createOpenAICompatibleInference({ ...remote, timeoutMs: 30 })(Buffer.from("prompt"))).rejects.toMatchObject({ code: "INFERENCE_BACKEND_TIMEOUT", statusCode: 504 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("GET");
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("does not POST when a healthy response arrives after its deadline", async () => {
    const abort = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    fetchMock.mockImplementationOnce(async () => { abort.abort(); return new Response(null, { status: 200 }); });
    await expect(createOpenAICompatibleInference(remote)(Buffer.from("prompt"))).rejects.toMatchObject({ code: "INFERENCE_BACKEND_TIMEOUT" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never retries a failed POST even after a successful health check", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response("provider secret", { status: 503 }));
    await expect(createOpenAICompatibleInference(remote)(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference backend returned HTTP 503" });
    expect(fetchMock.mock.calls.map(([, request]) => request?.method)).toEqual(["GET", "POST"]);
  });

  it.each(["https://other.example/health", "//other.example/health", "/\\other.example/health", "//gpu.example.modal.run/health", "/health?secret=value", "/health#fragment", "health", "//["])("rejects unsafe health path %# before network access", (healthPath) => {
    expect(() => createOpenAICompatibleInference({ ...remote, healthPath })).toThrow(/health path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires HTTPS and authentication even for an opted-in loopback health check", () => {
    expect(() => createOpenAICompatibleInference({ ...remote, baseUrl: "http://localhost:8000/v1" })).toThrow(/HTTPS/);
    expect(() => createOpenAICompatibleInference({ ...remote, baseUrl: "https://localhost:8000/v1", apiKey: "" })).toThrow("Inference health check requires an API key");
  });

  it("redacts a failing health transport and does not send the prompt", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Authorization: Bearer health-secret"));
    await expect(createOpenAICompatibleInference(remote)(Buffer.from("prompt"))).rejects.toMatchObject({ message: "Inference backend request failed", statusCode: 502 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("local HTTP inference transport", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  async function listen(server: Server): Promise<string> {
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local HTTP test port");
    return `http://127.0.0.1:${address.port}/v1`;
  }

  it("talks to a real loopback HTTP server with the compatible request shape", async () => {
    vi.unstubAllGlobals();
    let received: unknown;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      received = { method: request.method, url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "CPU model response" } }] }));
    });
    const baseUrl = await listen(server);
    const answer = await createOpenAICompatibleInference({ baseUrl, model: "cpu-model" })(Buffer.from("local prompt"));
    expect(answer.toString()).toBe("CPU model response");
    expect(received).toMatchObject({ method: "POST", url: "/v1/chat/completions", body: { model: "cpu-model", messages: [{ role: "user", content: "local prompt" }] } });
  });

  it("aborts stalled HTTP responses at the configured timeout", async () => {
    vi.unstubAllGlobals();
    const baseUrl = await listen(createServer(() => {}));
    await expect(createOpenAICompatibleInference({ baseUrl, model: "local-model", timeoutMs: 30 })(Buffer.from("prompt"))).rejects.toMatchObject({
      code: "INFERENCE_BACKEND_TIMEOUT", statusCode: 504, message: "Inference backend timed out",
    });
  });

  it("does not follow redirects to another service with the prompt or credentials", async () => {
    vi.unstubAllGlobals();
    const destination = vi.fn();
    const baseUrl = await listen(createServer((request, response) => {
      if (request.url === "/stolen") destination();
      response.writeHead(307, { location: "/stolen" });
      response.end();
    }));
    await expect(createOpenAICompatibleInference({ baseUrl, model: "local-model", apiKey: "secret" })(Buffer.from("private"))).rejects.toMatchObject({ code: "INFERENCE_BACKEND_FAILED" });
    expect(destination).not.toHaveBeenCalled();
  });
});
