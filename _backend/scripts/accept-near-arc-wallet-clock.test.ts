import { describe, expect, it } from "vitest";
import { createSiweMessage } from "viem/siwe";
import type { Hex } from "viem";
import { ACCEPTANCE_CLOCK_SKEW_MS, walletChallengeChecks, walletSessionChecks } from "./accept-near-arc.js";
const now = Date.parse("2026-10-01T16:00:00Z"), origin = "https://acceptance.example.test";
const payer: Hex = `0x${"11".repeat(20)}`, other: Hex = `0x${"22".repeat(20)}`, id = "21".repeat(24);
function challenge(offset: number, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}, expiryOffset = 300_000) {
  return { id, expiresAt: new Date(now + offset + expiryOffset).toISOString(), message: createSiweMessage({
    address: payer, domain: new URL(origin).host, uri: `${origin}/dashboard`, chainId: 5042, version: "1", nonce: id,
    statement: "Sign in to Enclave. This does not authorize a payment.", issuedAt: new Date(now + offset), expirationTime: new Date(now + offset + expiryOffset), ...overrides }) };
}
const failed = (checks: ReturnType<typeof walletChallengeChecks> | ReturnType<typeof walletSessionChecks>) => Object.entries(checks).filter(([, value]) => value !== true).map(([key]) => key);
describe("bounded acceptance wallet clock checks", () => {
  it.each([0, 25, ACCEPTANCE_CLOCK_SKEW_MS])("accepts exact scope and a server clock %i ms ahead", offset => {
    expect(failed(walletChallengeChecks(challenge(offset), payer, origin, now))).toEqual([]);
    expect(failed(walletSessionChecks({ address: payer, expiresAt: new Date(now + 30 * 60_000 + offset).toISOString() }, payer, now))).toEqual([]);
  });
  it("rejects one millisecond beyond the skew boundary for challenge and verified session", () => {
    expect(failed(walletChallengeChecks(challenge(30_001), payer, origin, now))).toEqual(["issuedAtNotFuture", "expiryMaximum"]);
    expect(failed(walletSessionChecks({ address: payer, expiresAt: new Date(now + 30 * 60_000 + 30_001).toISOString() }, payer, now))).toEqual(["expiryMaximum"]);
  });
  it("retains the exact five-minute challenge lifetime and rejects challenges older than five minutes", () => {
    expect(failed(walletChallengeChecks(challenge(0, {}, 300_001), payer, origin, now))).toContain("challengeLifetime");
    expect(failed(walletChallengeChecks(challenge(-300_001), payer, origin, now))).toContain("issuedAtFresh");
    expect(failed(walletChallengeChecks(challenge(-300_000), payer, origin, now))).toContain("expiryFuture");
  });
  it("retains exact expiry binding and wallet session ownership", () => {
    const altered = challenge(25); altered.expiresAt = new Date(now + 300_024).toISOString();
    expect(failed(walletChallengeChecks(altered, payer, origin, now))).toContain("expiryBinding");
    expect(failed(walletSessionChecks({ address: other, expiresAt: new Date(now + 30 * 60_000).toISOString() }, payer, now))).toEqual(["address"]);
    expect(failed(walletSessionChecks({ address: payer, expiresAt: new Date(now).toISOString() }, payer, now))).toEqual(["expiryFuture"]);
  });
  it.each([
    { field: "address", override: { address: other } }, { field: "domain", override: { domain: "evil.example.test" } },
    { field: "uri", override: { uri: `${origin}/other` } }, { field: "chainId", override: { chainId: 1 } },
    { field: "nonce", override: { nonce: "99".repeat(24) } }, { field: "statement", override: { statement: "Authorize a payment." } },
  ])("retains the exact $field check within the skew allowance", ({ field, override }) => {
    expect(failed(walletChallengeChecks(challenge(25, override), payer, origin, now))).toContain(field);
  });
  it("reports fixed field names without raw message, nonce, or bearer", () => {
    const checks = walletChallengeChecks({ id, message: "private-invalid-message", expiresAt: new Date(now + 300_000).toISOString() }, payer, origin, now);
    expect(failed(checks).length).toBeGreaterThan(0);
    expect(JSON.stringify(checks)).not.toContain("private-invalid-message");
    expect(JSON.stringify(checks)).not.toContain(id);
  });
});
