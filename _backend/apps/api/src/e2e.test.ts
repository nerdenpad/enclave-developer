import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptAesGcm, sha256Hex } from "@enclave/core";
import { apiKeys, createDb } from "@enclave/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("e2e days 4-7", () => {
  const apiKey = `enclave_test_${Date.now()}`;
  const log = createLogger("fatal");
  let db: ReturnType<typeof createDb>["db"];
  let sql: ReturnType<typeof createDb>["sql"];
  let gateway: EnclaveGateway;
  let app: ReturnType<typeof createApp>;
  let sessionId = "";
  let wrapKey = Buffer.alloc(0);

  async function json(path: string, init?: RequestInit) {
    const res = await app.request(path, init);
    const body = await res.json();
    return { status: res.status, body };
  }

  beforeAll(async () => {
    const cfg = loadConfig();
    ({ db, sql } = createDb(cfg.DATABASE_URL));
    await db.insert(apiKeys).values({ keyHash: sha256Hex(apiKey), role: "admin", label: "e2e", usdcBalance: 0n });
    gateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    app = createApp(gateway, log);
    const quote = await json("/v1/attestation/quote");
    const session = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(quote.body),
    });
    expect(session.status).toBe(201);
    sessionId = (session.body as { sessionId: string }).sessionId;
    wrapKey = Buffer.from((session.body as { wrapKey: string }).wrapKey, "base64");
  }, 30_000);

  afterAll(async () => {
    await gateway?.restoreServingModel(apiKey).catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  it("seals agent memory so plaintext never appears in API JSON", async () => {
    const blob = encryptAesGcm(wrapKey, Buffer.from("secret-diary"));
    const created = await json("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        name: "ops-bot",
        dailyLimitUsdc: 50,
        sessionId,
        ...blob,
      }),
    });
    expect(created.status).toBe(201);
    const raw = JSON.stringify(created.body);
    expect(raw).not.toContain("secret-diary");
    expect(created.body.sealedMemory.ciphertext).toBeTruthy();
    expect(created.body.memoryHash).toMatch(/^0x/);

    const fetched = await json(`/v1/agents/${created.body.id}`, {
      headers: { "x-api-key": apiKey },
    });
    expect(JSON.stringify(fetched.body)).not.toContain("secret-diary");
  });

  it("rejects agent spend over the daily mandate", async () => {
    const created = await json("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ name: "broke-bot", dailyLimitUsdc: 0.01 }),
    });
    const blob = encryptAesGcm(wrapKey, Buffer.from("hello"));
    const unpaid = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId, agentId: created.body.id, ...blob }),
    });
    expect(unpaid.status).toBe(402);
    const paymentId = unpaid.body.details.accepts[0].extra.paymentId as string;
    const settled = await json("/v1/x402/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ paymentId }),
    });
    expect(settled.status).toBe(403);
    expect(settled.body.title).toBe("MANDATE_BREACH");
  });

  it("lets an in-limit agent infer, then view-key export is auditor-only", async () => {
    const created = await json("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ name: "rich-bot", dailyLimitUsdc: 50 }),
    });
    const blob = encryptAesGcm(wrapKey, Buffer.from("hello agent"));
    const unpaid = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "idempotency-key": `e2e-${Date.now()}` },
      body: JSON.stringify({ sessionId, agentId: created.body.id, ...blob }),
    });
    const paymentId = unpaid.body.details.accepts[0].extra.paymentId as string;
    await json("/v1/x402/settle", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ paymentId }),
    });
    const paid = await json("/v1/inference", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "x-payment": paymentId,
        "idempotency-key": `e2e-${Date.now()}-ok`,
      },
      body: JSON.stringify({ sessionId, agentId: created.body.id, ...blob }),
    });
    expect(paid.status).toBe(200);
    expect(paid.body.typedHash).toMatch(/^0x/);

    const issued = await json("/v1/compliance/view-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ label: "auditor" }),
    });
    expect(issued.status).toBe(201);
    const secret = issued.body.secret as string;

    const denied = await json("/v1/compliance/export", { headers: { "x-view-key": "stranger" } });
    expect(denied.status).toBe(403);

    const exported = await json("/v1/compliance/export", { headers: { "x-view-key": secret } });
    expect(exported.status).toBe(200);
    expect(exported.body.receipts.length).toBeGreaterThan(0);
    expect(exported.body.payments.length).toBeGreaterThan(0);
    expect(exported.body.receipts.some((r: { typedHash: string }) => r.typedHash === paid.body.typedHash)).toBe(true);
  });

  it("returns 403 when the serving model is revoked", async () => {
    await gateway.revokeServingModel(apiKey);
    const blob = encryptAesGcm(wrapKey, Buffer.from("nope"));
    const res = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(res.status).toBe(403);
    expect(res.body.title).toBe("MODEL_NOT_APPROVED");
    await gateway.restoreServingModel(apiKey);
  });

  it("previews the 80/10/5/5 fee split", async () => {
    const res = await json("/v1/fees/split?amount=1000000", { headers: { "x-api-key": apiKey } });
    expect(res.status).toBe(200);
    expect(res.body.treasury).toBe("800000");
    expect(res.body.stakers).toBe("100000");
    expect(res.body.providers).toBe("50000");
    expect(res.body.ecosystem).toBe("50000");
  });

  it("stakes and unstakes ENCL on Anvil when configured", async () => {
    const status = await json("/v1/stake", { headers: { "x-api-key": apiKey } });
    if (!status.body.configured) {
      return;
    }
    const stake = await json("/v1/stake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ amountWei: (10n ** 18n).toString() }),
    });
    expect(stake.status).toBe(200);
    expect(BigInt(stake.body.staked as string)).toBeGreaterThan(0n);
    const unstake = await json("/v1/unstake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ amountWei: (10n ** 18n).toString() }),
    });
    expect(unstake.status).toBe(200);
  });
});
