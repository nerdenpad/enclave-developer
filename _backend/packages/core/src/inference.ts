import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { AppError, ValidationError } from "./errors.js";

/** Software inference only. This interface makes no hardware-confidentiality claim. */
export type InferenceAdapter = (plaintext: Buffer) => Promise<Buffer>;

export type OpenAICompatibleInferenceOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxTokens?: number;
  /** Explicit opt-in for a trusted server outside this host. Defaults to loopback only. */
  allowRemote?: boolean;
  /** Optional authenticated readiness path on the same HTTPS origin, for cold starts. */
  healthPath?: string;
};

const responseSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().min(1) }) })).min(1),
});

function positiveInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid inference ${name}`);
  return value;
}

function endpointFor(options: OpenAICompatibleInferenceOptions): URL {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    throw new Error("Invalid inference base URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Inference base URL must be HTTP(S) without credentials, query or fragment");
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (!loopback && !options.allowRemote) throw new Error("Remote inference requires explicit opt-in");
  if (!loopback && url.protocol !== "https:") throw new Error("Remote inference requires HTTPS");
  if (!loopback && !options.apiKey?.trim()) throw new Error("Remote inference requires an API key");
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path || "/v1"}/chat/completions`;
  return url;
}

function healthEndpointFor(options: OpenAICompatibleInferenceOptions, endpoint: URL): URL | undefined {
  if (!options.healthPath) return undefined;
  let url: URL;
  try { url = new URL(options.healthPath, endpoint.origin); }
  catch { throw new Error("Invalid inference health path"); }
  if (!options.healthPath.startsWith("/") || options.healthPath.startsWith("//") || url.origin !== endpoint.origin || url.protocol !== "https:"
    || url.username || url.password || url.search || url.hash) {
    throw new Error("Inference health path must be an absolute path on the same HTTPS origin without query or fragment");
  }
  if (!options.apiKey?.trim()) throw new Error("Inference health check requires an API key");
  return url;
}

async function waitForHealthy(endpoint: URL, headers: Record<string, string>, signal: AbortSignal): Promise<void> {
  while (true) {
    signal.throwIfAborted();
    // A slow Modal cold start can return a 303 result URL. Do not follow it or
    // resend a prompt: poll this fixed, authenticated health endpoint instead.
    const response = await fetch(endpoint, { method: "GET", headers, redirect: "manual", signal });
    await response.body?.cancel();
    signal.throwIfAborted();
    if (response.status === 200) return;
    if (![303, 502, 503, 504].includes(response.status)) {
      throw new AppError("INFERENCE_BACKEND_FAILED", `Inference health check returned HTTP ${response.status}`, 502);
    }
    await delay(1000, undefined, { signal });
  }
}

async function limitedJson(response: Response, maximum: number): Promise<unknown> {
  const declaredSize = response.headers.get("content-length");
  if (declaredSize !== null && Number(declaredSize) > maximum) {
    await response.body?.cancel();
    throw new AppError("INFERENCE_BACKEND_FAILED", "Inference backend response is too large", 502);
  }
  if (!response.body) throw new AppError("INFERENCE_BACKEND_FAILED", "Inference backend returned an empty response", 502);
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new AppError("INFERENCE_BACKEND_FAILED", "Inference backend response is too large", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError("INFERENCE_BACKEND_FAILED", "Inference backend returned invalid JSON", 502);
  }
}

/** Connects to a local or explicitly trusted HTTPS chat-completions server. Remote inference is software-only. */
export function createOpenAICompatibleInference(options: OpenAICompatibleInferenceOptions): InferenceAdapter {
  const endpoint = endpointFor(options);
  const healthEndpoint = healthEndpointFor(options, endpoint);
  const model = options.model.trim();
  if (!model || model.length > 512) throw new Error("Invalid inference model");
  const timeoutMs = positiveInteger(options.timeoutMs ?? 30_000, 300_000, "timeout");
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? 1_048_576, 16_777_216, "output limit");
  const maxTokens = positiveInteger(options.maxTokens ?? 1024, 131_072, "token limit");
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const apiKey = options.apiKey?.trim();
  if (apiKey && /[\r\n]/.test(apiKey)) throw new Error("Invalid inference API key");
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  return async (plaintext: Buffer): Promise<Buffer> => {
    let prompt: string;
    try {
      prompt = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new ValidationError({ prompt: "Expected UTF-8 text" });
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      if (healthEndpoint) await waitForHealthy(healthEndpoint, headers, signal);
      signal.throwIfAborted();
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        redirect: "error",
        signal,
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: false, temperature: 0, max_tokens: maxTokens }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError("INFERENCE_BACKEND_FAILED", `Inference backend returned HTTP ${response.status}`, 502);
      }
      // Allow JSON escaping and envelope metadata while bounding the entire response stream.
      const parsed = responseSchema.safeParse(await limitedJson(response, maxOutputBytes * 6 + 16_384));
      if (!parsed.success) throw new AppError("INFERENCE_BACKEND_FAILED", "Inference backend returned an invalid completion", 502);
      const output = Buffer.from(parsed.data.choices[0]!.message.content, "utf8");
      if (output.length > maxOutputBytes) throw new AppError("INFERENCE_BACKEND_FAILED", "Inference output exceeds configured limit", 502);
      return output;
    } catch (error) {
      if (signal.aborted) throw new AppError("INFERENCE_BACKEND_TIMEOUT", "Inference backend timed out", 504);
      if (error instanceof AppError) throw error;
      // Do not forward provider errors: they can contain prompts, output or credentials.
      throw new AppError("INFERENCE_BACKEND_FAILED", "Inference backend request failed", 502);
    }
  };
}
