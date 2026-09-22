import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fromHex, randomBytes32, toHex, type VendorRoots } from "@enclave/core";

export type StoredCvm = {
  vendorPrivateKey: `0x${string}`;
  enclavePrivateKey: `0x${string}`;
  wrappingKey: `0x${string}`;
  modelKey: `0x${string}`;
};

const keySchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const storedSchema = z.object({ vendorPrivateKey: keySchema, enclavePrivateKey: keySchema, wrappingKey: keySchema, modelKey: keySchema });

export async function loadOrCreateCvmKeys(filePath = process.env.ENCLAVE_CVM_PATH ?? fileURLToPath(new URL("../../../data/cvm.json", import.meta.url))): Promise<{
  stored: StoredCvm;
  vendor: VendorRoots;
}> {
  try {
    const raw = await readFile(filePath, "utf8");
    const stored = storedSchema.parse(JSON.parse(raw)) as StoredCvm;
    privateKeyToAccount(stored.enclavePrivateKey);
    const vendor: VendorRoots = {
      privateKey: stored.vendorPrivateKey,
      address: privateKeyToAccount(stored.vendorPrivateKey).address,
    };
    return { stored, vendor };
  } catch (err) {
    // Never rotate stored keys after corruption, invalid data or access errors.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const vendorPrivateKey = generatePrivateKey();
    const stored: StoredCvm = {
      vendorPrivateKey,
      enclavePrivateKey: generatePrivateKey(),
      wrappingKey: toHex(randomBytes32()),
      modelKey: toHex(randomBytes32()),
    };
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      await writeFile(filePath, `${JSON.stringify(stored, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return loadOrCreateCvmKeys(filePath);
    }
    const vendor: VendorRoots = {
      privateKey: stored.vendorPrivateKey,
      address: privateKeyToAccount(stored.vendorPrivateKey).address,
    };
    return { stored, vendor };
  }
}

export function storedToBuffers(stored: StoredCvm) {
  storedSchema.parse(stored);
  return {
    enclavePrivateKey: stored.enclavePrivateKey,
    wrappingKey: fromHex(stored.wrappingKey),
    modelKey: fromHex(stored.modelKey),
  };
}
