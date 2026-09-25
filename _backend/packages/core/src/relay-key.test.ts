import { describe, expect, it } from "vitest";
import { withRelayKey } from "./relay-key.js";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

describe("relay signer configuration", () => {
  it.skipIf(process.platform !== "linux")("loads a private file and rejects permissive, symlinked or mismatched records", () => {
    const dir = mkdtempSync(join(tmpdir(), "enclave-relay-test-"));
    const path = join(dir, "signer.json"), alias = join(dir, "link.json");
    const privateKey = `0x${"11".repeat(32)}` as const;
    const record = { version: 1, chainId: 5042, privateKey, address: privateKeyToAccount(privateKey).address };
    const env = { ARC_CHAIN_ID: "5042", RELAY_KEY_FILE: path };
    try {
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      expect(withRelayKey(env).DEPLOYER_PRIVATE_KEY).toBe(privateKey);
      expect(env).not.toHaveProperty("DEPLOYER_PRIVATE_KEY");
      chmodSync(path, 0o644);
      expect(() => withRelayKey(env)).toThrow("unsafe");
      chmodSync(path, 0o600);
      symlinkSync(path, alias);
      expect(() => withRelayKey({ ...env, RELAY_KEY_FILE: alias })).toThrow("unsafe");
      writeFileSync(path, JSON.stringify({ ...record, address: `0x${"22".repeat(20)}` }));
      expect(() => withRelayKey(env)).toThrow("unsafe");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps local development defaults isolated from mainnet", () => {
    const local = { ARC_CHAIN_ID: "31337" };
    expect(withRelayKey(local)).toBe(local);
    expect(() => withRelayKey({ ARC_CHAIN_ID: "5042" })).toThrow("dedicated relay signer");
    expect(() => withRelayKey({ ARC_CHAIN_ID: "5042", DEPLOYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" })).toThrow("forbidden");
  });
  it("rejects ambiguous or unsafe file configuration without exposing secrets", () => {
    const secret = "secret-that-must-not-appear";
    for (const env of [
      { ARC_CHAIN_ID: "5042", RELAY_KEY_FILE: "/not-a-signer", DEPLOYER_PRIVATE_KEY: secret },
      { ARC_CHAIN_ID: "31337", RELAY_KEY_FILE: "/not-a-signer" },
      { ARC_CHAIN_ID: "5042", RELAY_KEY_FILE: "relative/signer.json" },
    ]) {
      try { withRelayKey(env); expect.fail("Unsafe configuration accepted"); }
      catch (error) { expect(String(error)).toContain("Relay key file"); expect(String(error)).not.toContain(secret); }
    }
  });
});
