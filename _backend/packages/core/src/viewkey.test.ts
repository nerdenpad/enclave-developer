import { describe, expect, it } from "vitest";
import { hashViewSecret, viewSecretMatches } from "./viewkey.js";
import { modelServingAllowed, listingBpsValid } from "./registry.js";

describe("view keys", () => {
  it("accepts the issued secret and rejects a stranger", () => {
    const secret = "vk_live_auditor_one";
    const digest = hashViewSecret(secret);
    expect(viewSecretMatches(secret, digest)).toBe(true);
    expect(viewSecretMatches("vk_other", digest)).toBe(false);
    expect(viewSecretMatches(secret, hashViewSecret("nope"))).toBe(false);
  });
});

describe("marketplace listing", () => {
  it("rejects revoked or unapproved models", () => {
    expect(modelServingAllowed({ approved: true, revoked: false })).toBe(true);
    expect(modelServingAllowed({ approved: false, revoked: false })).toBe(false);
    expect(modelServingAllowed({ approved: true, revoked: true })).toBe(false);
    expect(modelServingAllowed(undefined)).toBe(false);
  });

  it("caps listing bps at 100%", () => {
    expect(listingBpsValid(250)).toBe(true);
    expect(listingBpsValid(10_000)).toBe(true);
    expect(listingBpsValid(10_001)).toBe(false);
    expect(listingBpsValid(-1)).toBe(false);
  });
});
