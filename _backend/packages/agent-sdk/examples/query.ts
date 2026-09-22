import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { createEnclaveMcpServer, type EnclaveMcpOptions } from "../src/index.js";

/** Example factory only. Importing this module does not query Claude or any API. */
export function createEnclaveAgentOptions(config: EnclaveMcpOptions): Options {
  return {
    mcpServers: { enclave: createEnclaveMcpServer(config) },
    // Keep built-in shell/filesystem tools out of this example's agent context.
    tools: [],
    // Read-only quote is pre-approved. Session/inference/payment remain subject
    // to the host's explicit permission policy and trusted wallet/key custody.
    allowedTools: ["mcp__enclave__enclave_quote"],
    maxTurns: 8,
  };
}

/** Explicit caller invocation may incur Claude/API charges; never run by tests. */
export function queryEnclaveAgent(prompt: string, config: EnclaveMcpOptions) {
  return query({ prompt, options: createEnclaveAgentOptions(config) });
}
