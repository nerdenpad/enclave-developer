import { config as loadDotenv } from "dotenv";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bannedSecretFields,
  encryptAesGcm,
  isHashOnlyReceipt,
  secretMaterialHits,
  sha256Hex,
} from "@enclave/core";
import { apiKeys, createDb, sessions } from "@enclave/db";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const hasDb = Boolean(process.env.DATABASE_URL);

type StoredCvm = {
  vendorPrivateKey: string;
  enclavePrivateKey: string;
  wrappingKey: string;
  modelKey: string;
};

describe.skipIf(!hasDb)("spec acceptance days 10-11", () => {
  const apiKey = `enclave_accept_${Date.now()}`;
  const prompt = "acceptance-secret-prompt";
  const log = createLogger("fatal");
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let gateway: EnclaveGateway;
  let app: ReturnType<typeof createApp>;
  let stored: StoredCvm;
  let sessionId = "";
  let wrapKey = Buffer.alloc(0);

  async function json(path: string, init?: RequestInit) {
    const res = await app.request(path, init);
    const body = await res.json();
    return { status: res.status, body };
  }

  function secretHits(body: unknown) {
    return secretMaterialHits(body, [
      stored.vendorPrivateKey,
      stored.enclavePrivateKey,
      stored.wrappingKey,
      stored.modelKey,
    ]);
  }

  beforeAll(async () => {
    const cfg = loadConfig();
    ({ db, sql } = createDb(cfg.DATABASE_URL));
    await db.insert(apiKeys).values({ keyHash: sha256Hex(apiKey), label: "e2e-accept", usdcBalance: 0n });
    gateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    app = createApp(gateway, log);
    stored = JSON.parse(await readFile(process.env.ENCLAVE_CVM_PATH ?? fileURLToPath(new URL("../../../data/cvm.json", import.meta.url)), "utf8")) as StoredCvm;
  }, 30_000);

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("(1) does not release keys from a quote alone, and inference without a session is 401", async () => {
    const health = await json("/health");
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);
    expect(health.body.teeMode).toBe("dev");
    expect(health.body.chainId).toBeTruthy();
    expect(secretHits(health.body)).toEqual([]);
    expect(bannedSecretFields(health.body)).toEqual([]);

    const quote = await json("/v1/attestation/quote");
    expect(quote.status).toBe(200);
    expect(quote.body.cpuQuote).toBeTruthy();
    expect(quote.body.gpuQuote).toBeTruthy();
    expect(quote.body.wrapKey).toBeUndefined();
    expect(secretHits(quote.body)).toEqual([]);

    const solvency = await json("/v1/solvency/USDC");
    expect(solvency.body.keysReleased).toBe(false);
    expect(secretHits(solvency.body)).toEqual([]);

    const dummy = encryptAesGcm(Buffer.alloc(32, 1), Buffer.from(prompt));
    const noKey = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "00000000-0000-4000-8000-000000000001", ...dummy }),
    });
    expect(noKey.status).toBe(401);

    const noSession = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId: "00000000-0000-4000-8000-000000000001", ...dummy }),
    });
    expect(noSession.status).toBe(401);
    expect(noSession.body.title).toBe("UNAUTHORIZED");
  });

  it("(2) rejects a tampered serving-image measurement and GPU-CC without CPU TEE", async () => {
    const quote = await json("/v1/attestation/quote");
    const tampered = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ ...quote.body, measurement: sha256Hex("evil-image") }),
    });
    expect(tampered.status).toBe(403);
    expect(tampered.body.title).toBe("TAMPERED_IMAGE");

    const gpuOnly = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ ...quote.body, cpuQuote: "" }),
    });
    expect(gpuOnly.status).toBe(403);
    expect(gpuOnly.body.title).toBe("ATTESTATION_FAILED");

    const expired = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ ...quote.body, timestamp: Date.now() - 10 * 60_000 }),
    });
    expect(expired.status).toBe(403);

    const solvency = await json("/v1/solvency/USDC");
    expect(solvency.body.keysReleased).toBe(false);
  });

  it("(4) unpaid inference returns HTTP 402 with x402 extra.paymentId", async () => {
    const quote = await json("/v1/attestation/quote");
    const session = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(quote.body),
    });
    expect(session.status).toBe(201);
    sessionId = session.body.sessionId as string;
    wrapKey = Buffer.from(session.body.wrapKey as string, "base64");
    expect(wrapKey.equals(Buffer.from(stored.modelKey.slice(2), "hex"))).toBe(false);
    expect(wrapKey.equals(Buffer.from(stored.wrappingKey.slice(2), "hex"))).toBe(false);
    expect(secretHits(session.body)).toEqual([]);

    const blob = encryptAesGcm(wrapKey, Buffer.from(prompt));
    const unpaid = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(unpaid.status).toBe(402);
    expect(unpaid.body.title).toBe("PAYMENT_REQUIRED");
    expect(unpaid.body.details.accepts[0].extra.paymentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(JSON.stringify(unpaid.body)).not.toContain(prompt);
  });

  it("(3) paid inference returns hashes + EIP-712 sig and never plaintext or CVM keys", async () => {
    const blob = encryptAesGcm(wrapKey, Buffer.from(prompt));
    const unpaid = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    const paymentId = unpaid.body.details.accepts[0].extra.paymentId as string;
    const settled = await json("/v1/x402/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ paymentId, confidential: true }),
    });
    expect(settled.status).toBe(200);
    expect(settled.body.confidential).toBe(true);
    expect(settled.body.tx).toBeTruthy();

    const paid = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-payment": paymentId,
      },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(paid.status).toBe(200);
    expect(paid.body.typedHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(paid.body.outputHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(paid.body.receipt.sig).toMatch(/^0x/);
    expect(paid.body.receipt.inHash).toMatch(/^0x/);
    expect(paid.body.prompt).toBeUndefined();
    expect(JSON.stringify(paid.body)).not.toContain(prompt);
    expect(secretHits(paid.body)).toEqual([]);
    expect(bannedSecretFields(paid.body)).toEqual([]);

    const pub = await json(`/v1/receipts/${paid.body.typedHash}`);
    expect(pub.status).toBe(200);
    expect(isHashOnlyReceipt(pub.body)).toBe(true);
    expect(pub.body.sig).toBeUndefined();
    expect(JSON.stringify(pub.body)).not.toContain(prompt);
  });

  it("replays the same Idempotency-Key without a second charge", async () => {
    const blob = encryptAesGcm(wrapKey, Buffer.from(`${prompt}-idempotency`));
    const idempotencyKey = `accept-${Date.now()}`;
    const unpaid = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(unpaid.status).toBe(402);
    const paymentId = unpaid.body.details.accepts[0].extra.paymentId as string;
    const unpaidAgain = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(unpaidAgain.status).toBe(402);
    expect(unpaidAgain.body.details.accepts[0].extra.paymentId).toBe(paymentId);

    const settled = await json("/v1/x402/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ paymentId }),
    });
    expect(settled.status).toBe(200);

    const paid = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-payment": paymentId,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(paid.status).toBe(200);
    const replay = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-payment": paymentId,
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.typedHash).toBe(paid.body.typedHash);

    const consumed = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-payment": paymentId,
      },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect([402, 409]).toContain(consumed.status);
  });

  it("rejects inference on an expired session", async () => {
    const quote = await json("/v1/attestation/quote");
    const session = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(quote.body),
    });
    const expiredId = session.body.sessionId as string;
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.id, expiredId));
    const blob = encryptAesGcm(Buffer.from(session.body.wrapKey as string, "base64"), Buffer.from(prompt));
    const res = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId: expiredId, ...blob }),
    });
    expect(res.status).toBe(401);
    expect(res.body.detail).toMatch(/expired/i);
  });
});
