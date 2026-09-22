import { describe, expect, it } from "vitest";
import {
  DevCvm,
  ModelNotApprovedError,
  agentAllowsModel,
  assertAgentModel,
  createVendorRoots,
  hashAgentPolicy,
  publicAgentRecord,
} from "./index.js";

const policy = {
  version: 1,
  servingImageId: "enclave-echo-v1",
  requireCpuTee: true as const,
  requireGpuCc: true as const,
};

describe("agent policy", () => {
  it("hashes stably regardless of allowedModels order", () => {
    const a = hashAgentPolicy({ dailyLimitUnits: 100n, allowedModels: ["0xbb", "0xaa"] });
    const b = hashAgentPolicy({ dailyLimitUnits: 100n, allowedModels: ["0xAA", "0xBB"] });
    expect(a).toBe(b);
  });

  it("empty allow-list accepts any model; explicit list rejects others", () => {
    expect(agentAllowsModel({ dailyLimitUnits: 1n, allowedModels: [] }, "0xabc")).toBe(true);
    expect(() =>
      assertAgentModel({ dailyLimitUnits: 1n, allowedModels: ["0xabc"] }, "0xdef"),
    ).toThrow(ModelNotApprovedError);
  });

  it("publicAgentRecord never includes memoryPlaintext", () => {
    const view = publicAgentRecord({
      id: "1",
      sealedMemory: { iv: "x", tag: "y", ciphertext: "z" },
      memoryPlaintext: "secret-diary",
    });
    expect(JSON.stringify(view)).not.toContain("secret-diary");
    expect("memoryPlaintext" in view).toBe(false);
  });
});

describe("sealed agent memory", () => {
  it("stores only ciphertext; CVM can open it, outsiders cannot", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(
      { policy, modelId: "echo", chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" },
      vendor,
    );
    const sealed = cvm.sealMemory(Buffer.from("secret-diary"));
    expect(sealed.ciphertext).not.toContain("secret-diary");
    expect(Buffer.from(sealed.ciphertext, "base64").toString("utf8")).not.toContain("secret-diary");
    await cvm.releaseKeys(await cvm.quote(), vendor.address);
    expect(cvm.openMemory(sealed).toString("utf8")).toBe("secret-diary");

    const other = await DevCvm.create(
      { policy, modelId: "echo", chainId: 31337, verifyingContract: "0x0000000000000000000000000000000000000001" },
      vendor,
    );
    await other.releaseKeys(await other.quote(), vendor.address);
    expect(() => other.openMemory(sealed)).toThrow();
  });
});
