import { describe, expect, it } from "vitest";
import { productionReleaseOptions } from "./check-production-release.js";

describe("offline production release CLI", () => {
  it("requires an explicit manifest and never infers trust from environment files", () => {
    expect(productionReleaseOptions(["--manifest", "reviewed-release.json"])).toEqual({ manifestPath: "reviewed-release.json" });
    expect(productionReleaseOptions(["--help"])).toEqual({ help: true });
  });
  it.each([[], ["--manifest"], ["--manifest", "--help"], ["--manifest", " "], ["--apply"], ["--manifest", "release.json", "--send"]].map(args => ({ args })))("rejects ambiguous or mutation arguments %#", ({ args }) => {
    expect(() => productionReleaseOptions(args)).toThrow("Offline only");
  });
});
