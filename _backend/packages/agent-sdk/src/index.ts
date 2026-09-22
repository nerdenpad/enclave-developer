import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
// MCP supports Zod's stable v3 compatibility API; this also interoperates with
// the gateway workspace's v3 schemas while the Agent SDK's v4 peer is installed.
import { z } from "zod/v3";

const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const signature = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
const uint256 = z.string().regex(/^\d{1,78}$/).refine((value) => /^\d{1,78}$/.test(value) && BigInt(value) < 1n << 256n);
const base64 = (bytes: number, exact = true) => z.string().max(Math.ceil(bytes / 3) * 4)
  .refine((value) => {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value && (exact ? decoded.length === bytes : decoded.length > 0 && decoded.length <= bytes);
  }, "Expected canonical base64 of the permitted length");
const blobShape = { iv: base64(12), tag: base64(16), ciphertext: base64(1_048_576, false) };
const quoteShape = {
  cpuQuote: z.string().min(1).max(131_072), gpuQuote: z.string().min(1).max(1_048_576), measurement: hash,
  tcbVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  timestamp: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), signature,
};
const sessionSchema = z.object({ sessionId: z.string().uuid(), expiresAt: z.string().datetime(), wrapKey: base64(32) });
const receiptFields = { modelHash: hash, codeHash: hash, inHash: hash, outHash: hash, attRef: hash, ts: uint256, sig: signature };
const receiptSchema = z.discriminatedUnion("receiptVersion", [
  z.object({ ...receiptFields, receiptVersion: z.literal(1) }),
  z.object({ ...receiptFields, receiptVersion: z.literal(2), nonce: hash }),
]);
// Format validation only: consumers independently verify the proof's signatures
// and hardware evidence. Unknown gateway fields never enter the agent context.
const providerProofSchema = z.object({
  version: z.literal(1), receiptHash: hash, evidenceHash: hash, sig: signature,
  evidence: z.object({
    schemaVersion: z.literal(1), provider: z.literal("near"), signatureKind: z.literal("provider_tee"),
    endpoint: z.string().url().max(2048), model: z.string().min(1).max(512),
    completionId: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/), requestHash: hash, responseHash: hash,
    outputHash: hash, signatureText: z.string().max(1024), signature, signingAddress: address,
    attestationRef: hash, verifiedAt: z.string().datetime(), expiresAt: z.string().datetime(), tlsBound: z.literal(true),
  }),
});
const inferenceSchema = z.object({ receipt: receiptSchema, typedHash: hash, outputHash: hash,
  output: z.object(blobShape),
  // Private transcripts include request/response bytes plus hardware evidence.
  // The total serialized HTTP response is independently limited to 8 MiB.
  providerEvidence: z.object({ proof: providerProofSchema,
    transcript: z.object({ ...blobShape, ciphertext: base64(6_291_456, false) }) }).optional(),
});
const settlementSchema = z.object({ paymentId: z.string().uuid(), tx: hash, confidential: z.boolean() });
const paymentSchema = z.object({ x402Version: z.literal(1), accepts: z.array(z.object({
  scheme: z.literal("exact"), network: z.string().regex(/^arc-\d{1,20}$/), maxAmountRequired: uint256,
  payTo: address, asset: address, extra: z.object({ receiptPending: z.boolean(), paymentId: z.string().uuid() }),
})).min(1).max(10) });

export type EnclaveSession = z.infer<typeof sessionSchema>;
export type EnclaveMcpOptions = {
  /** One fixed origin; paths, userinfo, query strings and fragments are rejected. */
  baseUrl: string;
  /** Kept in this process and sent only as the gateway's x-api-key header. */
  apiKey: string;
  timeoutMs?: number;
  allowInsecureLocalhost?: boolean;
  /** Trusted host stores the wrapKey here; it is never included in MCP output. */
  onSession?: (session: EnclaveSession) => void | Promise<void>;
};

export const ENCLAVE_MCP_TOOL_NAMES = ["enclave_quote", "enclave_session", "enclave_infer", "enclave_settle"] as const;

class ToolFailure extends Error {
  constructor(readonly code: string, readonly status?: number, readonly payment?: z.infer<typeof paymentSchema>) {
    super(code);
  }
}

function gatewayOrigin(options: EnclaveMcpOptions): URL {
  let url: URL;
  try { url = new URL(options.baseUrl); } catch { throw new Error("Invalid Enclave gateway origin"); }
  const local = options.allowInsecureLocalhost === true && url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Enclave requires one HTTPS origin or explicitly allowed HTTP loopback");
  }
  return url;
}

function result(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) };
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maximum = 8_388_608;
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
    throw new ToolFailure("GATEWAY_RESPONSE_INVALID");
  }
  if (!response.body) throw new ToolFailure("GATEWAY_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await bounded(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maximum) {
        await bounded(reader.cancel(), signal);
        throw new ToolFailure("GATEWAY_RESPONSE_INVALID");
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
  } finally { reader.releaseLock(); }
}

/** Actual in-process Claude Agent SDK server. Constructing it never starts an LLM. */
export function createEnclaveMcpServer(options: EnclaveMcpOptions): McpSdkServerConfigWithInstance {
  const origin = gatewayOrigin(options);
  const apiKey = options.apiKey;
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new Error("Invalid Enclave API key");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("Invalid Enclave timeout");
  const onSession = options.onSession;
  if (onSession !== undefined && typeof onSession !== "function") throw new Error("Invalid Enclave session handler");
  const server = createSdkMcpServer({ name: "enclave", version: "0.1.0", timeout: Math.max(1000, timeoutMs),
    instructions: "Tools call a configured Enclave gateway. Inputs and outputs remain encrypted. Session wrapping keys stay in the trusted host. Payment signing and encrypted payload preparation require the host runtime; no wallet is created by this server.",
  });

  function register(name: typeof ENCLAVE_MCP_TOOL_NAMES[number], description: string, shape: z.ZodRawShape,
    path: string, output: z.ZodType, annotations: ToolAnnotations, method: "GET" | "POST" = "POST") {
    const definition = tool(name, description, shape, async (args, extra) => {
      const deadline = AbortSignal.timeout(timeoutMs);
      const callerSignal = (extra as { signal?: unknown } | undefined)?.signal;
      const signal = callerSignal instanceof AbortSignal ? AbortSignal.any([deadline, callerSignal]) : deadline;
      try {
        signal.throwIfAborted();
        if (name === "enclave_session" && !onSession) throw new ToolFailure("SESSION_HANDLER_REQUIRED");
        const { idempotencyKey, ...body } = args;
        const serialized = method === "GET" ? undefined : JSON.stringify(body);
        if (serialized !== undefined && Buffer.byteLength(serialized) > 2_097_152) throw new ToolFailure("GATEWAY_REQUEST_TOO_LARGE");
        const url = new URL(path, origin);
        const response = await bounded(fetch(url, { method, redirect: "error", signal,
          headers: { "x-api-key": apiKey, accept: "application/json", "content-type": "application/json",
            ...(typeof idempotencyKey === "string" ? { "idempotency-key": idempotencyKey } : {}) },
          ...(serialized === undefined ? {} : { body: serialized }),
        }), signal);
        if (response.redirected || (response.url && new URL(response.url).origin !== origin.origin)) throw new ToolFailure("GATEWAY_ORIGIN_MISMATCH");
        if (!response.ok && response.status !== 402) {
          await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
          throw new ToolFailure("GATEWAY_HTTP_ERROR", response.status);
        }
        const payload = await responseJson(response, signal);
        if (response.status === 402) {
          const parsed = z.object({ status: z.literal(402), title: z.literal("PAYMENT_REQUIRED"), details: paymentSchema }).safeParse(payload);
          if (!parsed.success) throw new ToolFailure("GATEWAY_RESPONSE_INVALID");
          throw new ToolFailure("PAYMENT_REQUIRED", 402, parsed.data.details);
        }
        const parsed = output.safeParse(payload);
        if (!parsed.success) throw new ToolFailure("GATEWAY_RESPONSE_INVALID");
        if (name === "enclave_session") {
          const session = parsed.data as EnclaveSession;
          await bounded(Promise.resolve(onSession!(session)), signal);
          return result({ sessionId: session.sessionId, expiresAt: session.expiresAt });
        }
        return result(parsed.data as Record<string, unknown>);
      } catch (error) {
        if (signal.aborted) return result({ error: deadline.aborted ? "GATEWAY_TIMEOUT" : "TOOL_CANCELLED" }, true);
        if (error instanceof ToolFailure) return result({ error: error.code,
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.payment === undefined ? {} : { payment: error.payment }),
        }, true);
        return result({ error: "GATEWAY_REQUEST_FAILED" }, true);
      }
    }, { annotations });
    // SDK's raw-shape convenience registration strips unknown properties.
    // Its public MCP instance accepts a strict Zod object, so reject them instead.
    // MCP and Agent SDK may resolve different Zod peer versions. Their public
    // compatibility layer supports both; erase only the recursive static type.
    const inputSchema = z.strictObject(shape) as unknown as AnySchema;
    server.instance.registerTool<never, AnySchema>(definition.name, { description: definition.description,
      inputSchema, annotations }, (args: unknown, extra: unknown) => definition.handler(args as Record<string, unknown>, extra));
  }

  register("enclave_quote", "Fetch the gateway's signed DEVELOPMENT software quote. This local session quote is not a hardware TDX/GPU attestation.",
    {}, "/v1/attestation/quote", z.object(quoteShape), { readOnlyHint: true, destructiveHint: false }, "GET");
  register("enclave_session", "Verify a development quote and create a session. The wrapping key is delivered only to the trusted host callback; tool output contains session ID and expiry.",
    quoteShape, "/v1/session", sessionSchema, { readOnlyHint: false, destructiveHint: false });
  register("enclave_infer", "Submit an already AES-GCM encrypted prompt. Return encrypted output, receipt and optional provider proof. HTTP 402 returns payment requirements; the host must prepare ciphertext and sign any payment authorization.",
    { sessionId: z.string().uuid(), ...blobShape, paymentId: z.string().uuid().optional(), agentId: z.string().uuid().optional(),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).optional() },
    "/v1/inference", inferenceSchema, { readOnlyHint: false, destructiveHint: false });
  register("enclave_settle", "Settle the specified payment intent. Supply an externally signed ERC-3009 authorization in authorized mode. This tool never creates a wallet or signs payment transactions; settlement spends funds and must follow host policy.",
    { paymentId: z.string().uuid(), confidential: z.boolean().optional(), authorization: z.strictObject({
      from: address, validAfter: uint256, validBefore: uint256, signature,
    }).optional() }, "/v1/x402/settle", settlementSchema, { readOnlyHint: false, destructiveHint: true });
  return server;
}
