import { describe, expect, it, vi } from "vitest";
import {
  DevCvm,
  AttestationFailedError,
  KeyNotReleasedError,
  createVendorRoots,
  receiptTypedHash,
  sha256,
  sha256Hex,
  verifyReceiptSignature,
  type TcbPolicy,
} from "./index.js";

const policy: TcbPolicy = {
  version: 3,
  servingImageId: "signed-serving-image-v3",
  requireCpuTee: true,
  requireGpuCc: true,
};
const config = {
  policy,
  modelId: "echo",
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000000100" as const,
};
const persisted = {
  enclavePrivateKey: `0x${"42".repeat(32)}` as const,
  wrappingKey: Buffer.alloc(32, 0x12),
  modelKey: Buffer.alloc(32, 0x34),
};
const now = 1_800_000_000_123;

describe("development CVM lifecycle", () => {
  it("requires attestation before issuing session secrets and inference receipts", async () => {
    const cvm = await DevCvm.create(config, await createVendorRoots(), persisted);
    expect(cvm.keysReleased()).toBe(false);
    expect(() => cvm.sessionSecret("session-1")).toThrow(KeyNotReleasedError);
    await expect(cvm.infer(Buffer.from("prompt"), { attRef: sha256Hex("unverified") }, now)).rejects.toThrow(KeyNotReleasedError);
  });

  it("attaches the verified quote and exact I/O hashes to every inference receipt", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    const quote = await cvm.quote(now);
    await cvm.releaseKeys(quote, vendor.address, now);
    const prompt = Buffer.from("private prompt");
    const { output, receipt } = await cvm.infer(prompt, { attRef: sha256Hex(quote.signature) }, now);
    expect(output).toEqual(sha256(Buffer.concat([persisted.modelKey, prompt])));
    expect(receipt).toMatchObject({
      receiptVersion: 2,
      modelHash: cvm.modelHash,
      codeHash: cvm.codeHash,
      inHash: sha256Hex(prompt),
      outHash: sha256Hex(output),
      attRef: sha256Hex(quote.signature),
      ts: 1_800_000_000n,
    });
    expect(await verifyReceiptSignature(receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
    expect(cvm.keysReleased()).toBe(true);
  });

  it("derives stable, separate secrets for distinct session IDs", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    await cvm.releaseKeys(await cvm.quote(now), vendor.address, now);
    const first = cvm.sessionSecret("session-1");
    expect(first).toHaveLength(32);
    expect(cvm.sessionSecret("session-1")).toEqual(first);
    expect(cvm.sessionSecret("session-2")).not.toEqual(first);
    first.fill(0);
    expect(cvm.sessionSecret("session-1")).not.toEqual(first);
  });

  it("preserves signer and sealed memory across restart while requiring fresh attestation", async () => {
    const vendor = await createVendorRoots();
    const original = await DevCvm.create(config, vendor, persisted);
    await original.releaseKeys(await original.quote(now), vendor.address, now);
    const sealed = original.sealMemory(Buffer.from("agent remembers"));
    const restarted = await DevCvm.create(config, vendor, persisted);
    expect(restarted.enclaveAddress).toBe(original.enclaveAddress);
    expect(restarted.keysReleased()).toBe(false);
    expect(() => restarted.openMemory(sealed)).toThrow(KeyNotReleasedError);
    await restarted.releaseKeys(await restarted.quote(now + 1000), vendor.address, now + 1000);
    expect(restarted.openMemory(sealed).toString()).toBe("agent remembers");
    expect(restarted.sessionSecret("existing-session")).toEqual(original.sessionSecret("existing-session"));
  });

  it("binds the receipt to its own session after another session verifies a newer quote", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    const first = await cvm.quote(now);
    const next = await cvm.quote(now + 1000);
    await cvm.releaseKeys(first, vendor.address, now);
    await cvm.releaseKeys(next, vendor.address, now + 1000);
    const result = await cvm.infer(Buffer.from("prompt"), { attRef: sha256Hex(first.signature) }, now + 1000);
    expect(result.receipt.attRef).toBe(sha256Hex(first.signature));
    expect(result.receipt.attRef).not.toBe(sha256Hex(next.signature));
  });

  it("gives concurrent identical calls in one second independent signed nonces", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    const quote = await cvm.quote(now);
    await cvm.releaseKeys(quote, vendor.address, now);
    const prompt = Buffer.from("same paid prompt");
    const context = { attRef: sha256Hex(quote.signature) };
    const [first, second] = await Promise.all([cvm.infer(prompt, context, now), cvm.infer(prompt, context, now + 100)]);
    expect(first.receipt.ts).toBe(second.receipt.ts);
    expect(first.receipt.attRef).toBe(second.receipt.attRef);
    expect(first.output).toEqual(second.output);
    expect(first.receipt.nonce).not.toBe(second.receipt.nonce);
    expect(receiptTypedHash(first.receipt, config.chainId, config.verifyingContract))
      .not.toBe(receiptTypedHash(second.receipt, config.chainId, config.verifyingContract));
  });

  it("supports an explicit stable invocation nonce without losing the session reference", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    const quote = await cvm.quote(now);
    await cvm.releaseKeys(quote, vendor.address, now);
    const context = { attRef: sha256Hex(quote.signature), nonce: sha256Hex("durable invocation") };
    const first = await cvm.infer(Buffer.from("prompt"), context, now);
    const retry = await cvm.infer(Buffer.from("prompt"), context, now);
    expect(first.receipt.nonce).toBe(context.nonce);
    expect(first.receipt).toEqual(retry.receipt);
    const fixed = { ...context, receiptTimestamp: 1_800_000_000n };
    const later = await cvm.infer(Buffer.from("prompt"), fixed, now + 60_000);
    expect(later.receipt).toEqual(first.receipt);
  });

  it("rejects an unverified session reference even after other keys were released", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    await cvm.releaseKeys(await cvm.quote(now), vendor.address, now);
    await expect(cvm.infer(Buffer.from("prompt"), { attRef: sha256Hex("unknown quote") }, now)).rejects.toThrow(AttestationFailedError);
    await expect(cvm.infer(Buffer.from("prompt"), { attRef: "0x12" }, now)).rejects.toThrow(AttestationFailedError);
  });

  it("rejects malformed invocation nonces and unsafe timestamps", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    const quote = await cvm.quote(now);
    await cvm.releaseKeys(quote, vendor.address, now);
    const context = { attRef: sha256Hex(quote.signature) };
    await expect(cvm.infer(Buffer.from("prompt"), { ...context, nonce: "0x12" }, now)).rejects.toThrow("Receipt nonce must be bytes32");
    for (const timestamp of [NaN, -1, 1.5, Infinity]) {
      await expect(cvm.infer(Buffer.from("prompt"), context, timestamp)).rejects.toThrow("Invalid receipt timestamp");
    }
    for (const receiptTimestamp of [-1n, 1n << 64n]) {
      await expect(cvm.infer(Buffer.from("prompt"), { ...context, receiptTimestamp }, now)).rejects.toThrow("Invalid receipt timestamp");
    }
  });

  it("runs an optional software inference adapter only after attestation and signs its actual output", async () => {
    const inference = vi.fn(async () => Buffer.from("real local model answer"));
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create({ ...config, inference }, vendor, persisted);
    const quote = await cvm.quote(now);
    const context = { attRef: sha256Hex(quote.signature) };
    const prompt = Buffer.from("private question");
    await expect(cvm.infer(prompt, context, now)).rejects.toThrow(KeyNotReleasedError);
    expect(inference).not.toHaveBeenCalled();
    await cvm.releaseKeys(quote, vendor.address, now);
    const result = await cvm.infer(prompt, context, now);
    expect(inference).toHaveBeenCalledExactlyOnceWith(prompt);
    expect(result.output.toString()).toBe("real local model answer");
    expect(result.receipt.inHash).toBe(sha256Hex(prompt));
    expect(result.receipt.outHash).toBe(sha256Hex(result.output));
    expect(await verifyReceiptSignature(result.receipt, cvm.enclaveAddress, config.chainId, config.verifyingContract)).toBe(true);
  });

  it("never mints a success receipt for failed or invalid adapter output", async () => {
    const inference = vi.fn(async (): Promise<Buffer> => { throw new Error("local model failed"); });
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create({ ...config, inference }, vendor, persisted);
    const quote = await cvm.quote(now);
    await cvm.releaseKeys(quote, vendor.address, now);
    const context = { attRef: sha256Hex(quote.signature) };
    await expect(cvm.infer(Buffer.from("prompt"), context, now)).rejects.toThrow("local model failed");
    inference.mockResolvedValueOnce("not bytes" as unknown as Buffer);
    await expect(cvm.infer(Buffer.from("prompt"), context, now)).rejects.toThrow("Inference adapter must return bytes");
  });

  it("keeps receipt hashes tied to the request snapshot across asynchronous inference", async () => {
    let complete!: (output: Buffer) => void;
    const inference = vi.fn(() => new Promise<Buffer>((resolve) => { complete = resolve; }));
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create({ ...config, inference }, vendor, persisted);
    const quote = await cvm.quote(now);
    await cvm.releaseKeys(quote, vendor.address, now);
    const prompt = Buffer.from("original");
    const pending = cvm.infer(prompt, { attRef: sha256Hex(quote.signature) }, now);
    prompt.fill(0);
    const backendOutput = Buffer.from("model output");
    complete(backendOutput);
    const result = await pending;
    backendOutput.fill(0);
    expect(result.receipt.inHash).toBe(sha256Hex("original"));
    expect(result.output.toString()).toBe("model output");
    expect(result.receipt.outHash).toBe(sha256Hex(result.output));
  });

  it("serializes only public identity and key-release state", async () => {
    const vendor = await createVendorRoots();
    const cvm = await DevCvm.create(config, vendor, persisted);
    await cvm.releaseKeys(await cvm.quote(now), vendor.address, now);
    const dump = JSON.stringify(cvm);
    expect(JSON.parse(dump)).toEqual({
      enclaveAddress: cvm.enclaveAddress,
      modelHash: cvm.modelHash,
      codeHash: cvm.codeHash,
      keysReleased: true,
    });
    for (const secret of [persisted.enclavePrivateKey, persisted.wrappingKey.toString("hex"), persisted.modelKey.toString("hex"), vendor.privateKey]) {
      if (secret) expect(dump).not.toContain(secret);
    }
    expect(cvm.debugFingerprint()).toEqual({ wrappingKeyFp: sha256Hex(persisted.wrappingKey), signer: cvm.enclaveAddress });
  });
});
