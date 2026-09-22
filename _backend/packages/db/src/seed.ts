import { eq } from "drizzle-orm";
import { config as loadDotenv } from "dotenv";
import { measurementOf, sha256Hex, usdcToUnits } from "@enclave/core";
import { createDb } from "./client.js";
import { apiKeys, mandates, models, tcbPolicy } from "./schema.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is required");
}

const servingImageId = process.env.SERVING_IMAGE_ID ?? "enclave-echo-v1";
const version = Number(process.env.TCB_POLICY_VERSION ?? "1");
const policy = {
  version,
  servingImageId,
  requireCpuTee: true as const,
  requireGpuCc: true as const,
};
const modelHash = sha256Hex("model:echo");
const codeHash = measurementOf(policy);
const demoKey = process.env.DEMO_API_KEY ?? "enclave_dev_key";
const keyHash = sha256Hex(demoKey);

const { db, sql } = createDb(url);

const existingPolicy = await db.select().from(tcbPolicy).where(eq(tcbPolicy.version, version)).limit(1);
if (existingPolicy.length === 0) {
  await db.insert(tcbPolicy).values({
    version,
    servingImageId,
    measurement: codeHash,
  });
}

const existingModel = await db.select().from(models).where(eq(models.modelHash, modelHash)).limit(1);
if (existingModel.length === 0) {
  await db.insert(models).values({
    modelHash,
    codeHash,
    version: "echo-v1",
    provider: "enclave",
    approved: true,
    revoked: false,
    listingBps: 0,
    listingId: 1,
  });
} else {
  await db
    .update(models)
    .set({ approved: true, revoked: false, listingBps: 0, listingId: 1 })
    .where(eq(models.modelHash, modelHash));
}

const existingKey = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
if (existingKey.length === 0) {
  await db.insert(apiKeys).values({
    keyHash,
    label: "dev",
    role: "admin",
    usdcBalance: 0n,
  });
} else {
  await db.update(apiKeys).set({ usdcBalance: 0n, role: "admin" }).where(eq(apiKeys.keyHash, keyHash));
}

const existingMandate = await db.select().from(mandates).where(eq(mandates.agent, keyHash)).limit(1);
if (existingMandate.length === 0) {
  await db.insert(mandates).values({
    agent: keyHash,
    dailyLimitUnits: usdcToUnits(50),
    spentTodayUnits: 0n,
    dayKey: new Date().toISOString().slice(0, 10),
    lane: "prefunded",
  });
}

await sql.end();
console.log(JSON.stringify({ demoApiKey: demoKey, modelHash, codeHash }, null, 2));
