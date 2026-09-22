import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateCvmKeys, storedToBuffers } from "./cvm-store.js";

const dirs: string[] = [];
async function file() { const dir = await mkdtemp(path.join(os.tmpdir(), "enclave-store-test-")); dirs.push(dir); return path.join(dir, "cvm.json"); }
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
describe("development CVM key persistence", () => {
  it("keeps the same identity and wrapping keys across boots", async () => {
    const target = await file();
    const first = await loadOrCreateCvmKeys(target);
    expect(await loadOrCreateCvmKeys(target)).toEqual(first);
    expect(storedToBuffers(first.stored).wrappingKey).toHaveLength(32);
    expect(storedToBuffers(first.stored).modelKey).toHaveLength(32);
    expect(first.stored.modelKey).not.toBe(first.stored.wrappingKey);
  });
  it.each(["{broken", "{}", JSON.stringify({ vendorPrivateKey: "0xab" })])("never replaces corrupt stored keys: %s", async (raw) => {
    const target = await file();
    await writeFile(target, raw);
    await expect(loadOrCreateCvmKeys(target)).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(raw);
  });
});
