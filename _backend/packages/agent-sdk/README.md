# Enclave Claude Agent SDK tools

`@enclave/agent-sdk` implements an actual in-process Claude Agent SDK MCP server using the official `tool()` and `createSdkMcpServer()` APIs. Tests connect the real SDK server to a real MCP `Client` over `InMemoryTransport`; one test also uses an isolated loopback HTTP gateway. No Anthropic key, Claude subprocess, external inference or paid model call is needed for these tests.

This package is an HTTP tool adapter. The autonomous sealed agent runtime, key custody, payment wallet and payment signing remain the responsibility of the host application. The adapter does not deploy an agent to a TEE or attest the process running Claude.

## Tools and gateway API

| MCP tool | Fixed gateway request | Result |
| --- | --- | --- |
| `enclave_quote` | `GET /v1/attestation/quote` | Signed development software quote; this route is not a hardware TDX/GPU quote. |
| `enclave_session` | `POST /v1/session` | Session ID and expiry. The wrapping key goes exclusively to the trusted host's `onSession` callback. |
| `enclave_infer` | `POST /v1/inference` | AES-GCM ciphertext, signed receipt, hashes and optional provider proof with encrypted transcript. A validated HTTP 402 challenge is returned as a tool error. |
| `enclave_settle` | `POST /v1/x402/settle` | Settlement transaction hash and payment ID. The caller supplies an externally signed ERC-3009 authorization when required by the gateway's payment mode. |

Tool inputs are strict: unknown properties and malformed hashes, addresses, signatures, UUIDs, uint256 decimal strings and base64 fields are rejected before HTTP. `enclave_infer` accepts `sessionId`, `iv`, `tag`, `ciphertext`, optional `paymentId` and `agentId`, and optional `idempotencyKey`; the latter becomes the `idempotency-key` header. `enclave_settle` accepts `paymentId`, optional `confidential`, and optional `authorization` containing `from`, `validAfter`, `validBefore` and `signature`.

The trusted host prepares encrypted prompts, decrypts outputs and stores the session wrapping key outside the model context. A missing `onSession` callback causes `SESSION_HANDLER_REQUIRED` before the session HTTP call. Never place private keys, wrapping keys or plaintext prompts in tool arguments. The adapter does not log tool data or credentials.

Response schemas retain only the gateway contract's known fields, including the versioned NEAR provider-proof fields. This is format validation, **not cryptographic verification** of receipt signatures, evidence hashes or CPU/GPU attestation. Clients must perform the independent verification provided by Enclave core and its hardware verifier before relying on a result. The adapter preserves encrypted payload bytes and does not decrypt the hardware transcript.

## Connect to an agent

```ts
import { createEnclaveMcpServer, type EnclaveSession } from "@enclave/agent-sdk";

// Supply these values from the trusted host's configuration/secret store.
// No environment variables or secret files are read by this package.
export function makeServer(baseUrl: string, apiKey: string) {
  const sessions = new Map<string, EnclaveSession>();
  const server = createEnclaveMcpServer({
    baseUrl,
    apiKey,
    timeoutMs: 120_000,
    onSession(session) {
      sessions.set(session.sessionId, session);
    },
  });
  return { server, sessions };
}
```

The map illustrates a host-only callback; it is not a sealed key store. The host must expire sessions, protect their keys and implement its own encrypted-payload preparation and payment policy.

[`examples/query.ts`](examples/query.ts) exports `createEnclaveAgentOptions(config)` and an explicitly invoked `queryEnclaveAgent(prompt, config)` wrapper. Importing it does not start a model or make network requests. Its SDK options mount the server as `mcpServers.enclave`, remove built-in shell/filesystem tools with `tools: []`, and pre-approve only `mcp__enclave__enclave_quote`. Mutating session, inference and settlement tools require the host's permission policy. Calling `queryEnclaveAgent` requires separately configured Claude authentication and may incur charges; the tests never call it.

## Configuration and limits

- `baseUrl` must be one HTTPS origin, optionally with a port. Userinfo, path prefixes, query strings and fragments are rejected. `allowInsecureLocalhost: true` permits HTTP only for exact `localhost`, `127.0.0.1` or `[::1]`. The configured origin is trusted host input and cannot be overridden by a tool call.
- `apiKey` remains in the handler's private closure and is sent only as `x-api-key` to that origin. Redirects are disabled; raw HTTP error bodies, network exceptions and callback errors are never returned to the model.
- `timeoutMs` defaults to 120,000 and must be between 1 and 300,000. The deadline includes fetching, streaming the body and the host callback. MCP cancellation propagates to the HTTP request. Timeout/cancellation cannot undo an already accepted gateway operation.
- HTTP mutations are never automatically retried. The host should reconcile an uncertain settlement before repeating it, and reuse an inference idempotency key only for the same operation.
- AES-GCM IVs are exactly 12 bytes and tags exactly 16 bytes. Input/output ciphertext is limited to 1 MiB of decoded bytes. Encrypted provider transcripts may be up to 6 MiB; the **entire serialized HTTP response** is still capped at 8 MiB, so simultaneous large output/proof/transcript can exceed that cap and fail closed. Serialized requests are capped at 2 MiB. Decimal amounts are bounded to uint256.
- The returned MCP content contains encrypted payloads and public metadata. Transport encryption to the gateway, encryption of the inference payload and hardware proof verification are separate guarantees; tool registration alone does not establish a TEE trust boundary.

## Offline verification

From the repository root:

```sh
npm run typecheck --workspace @enclave/agent-sdk
npm test --workspace @enclave/agent-sdk
npm test --workspace @enclave/agent-sdk -- --coverage
```

Dependencies are pinned to `@anthropic-ai/claude-agent-sdk@0.3.278`, `@anthropic-ai/sdk@0.127.0`, `@modelcontextprotocol/sdk@1.30.0` and `zod@4.6.5`. Zod's supported v3 compatibility namespace is used for interoperability with MCP's Zod peer and the existing gateway workspace. A narrow static type bridge is used when registering the strict object schema; runtime validation is exercised through the actual MCP transport.

Official API reference: [Claude Agent SDK custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools).
