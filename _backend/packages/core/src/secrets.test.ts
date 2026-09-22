import { describe, expect, it } from "vitest";
import { bannedSecretFields, isConfiguredAddress, secretMaterialHits } from "./index.js";

describe("isConfiguredAddress", () => {
  it("rejects the zero address and .env.example placeholders", () => {
    expect(isConfiguredAddress("0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isConfiguredAddress("0x0000000000000000000000000000000000000001")).toBe(false);
    expect(isConfiguredAddress("0x0000000000000000000000000000000000000004")).toBe(false);
    expect(isConfiguredAddress("0x0000000000000000000000000000000000000010")).toBe(false);
    expect(isConfiguredAddress("not-an-address")).toBe(false);
    expect(isConfiguredAddress("0x5FbDB2315678afecb367f032d93F642f64180aa3")).toBe(true);
  });
});

describe("secret scanners", () => {
  it("flags banned field names and hex material in JSON payloads", () => {
    expect(bannedSecretFields({ wrapKey: "ok", nested: { modelKey: "0xabc" } })).toEqual(["modelKey"]);
    expect(
      secretMaterialHits(
        { typedHash: "0xaaa", outputHash: "0xbbb" },
        ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      ),
    ).toEqual([]);
    expect(
      secretMaterialHits({ note: "leaked 0xbc1ac3f6e398430d0de18f547cfa70d7c70fbeaf4e4df5e811c7677310afefac" }, [
        "0xbc1ac3f6e398430d0de18f547cfa70d7c70fbeaf4e4df5e811c7677310afefac",
      ]),
    ).toHaveLength(1);
  });
});
