import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptAesGcm, isHashOnlyReceipt, sha256Hex } from "@enclave/core";
import { apiKeys, createDb } from "@enclave/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("e2e days 8-9", () => {
  const apiKey = `enclave_d89_${Date.now()}`;
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

  async function paidInfer(agentId: string, prompt: string) {
    const blob = encryptAesGcm(wrapKey, Buffer.from(prompt));
    const unpaid = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId, agentId, ...blob }),
    });
    expect(unpaid.status).toBe(402);
    const paymentId = unpaid.body.details.accepts[0].extra.paymentId as string;
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
      },
      body: JSON.stringify({ sessionId, agentId, ...blob }),
    });
    expect(paid.status).toBe(200);
    return paid.body as { typedHash: string };
  }

  beforeAll(async () => {
    const cfg = loadConfig();
    ({ db, sql } = createDb(cfg.DATABASE_URL));
    await db.insert(apiKeys).values({ keyHash: sha256Hex(apiKey), role: "admin", label: "e2e-d89", usdcBalance: 0n });
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
    await sql.end({ timeout: 5 });
  });

  it("rejects a quote whose TCB version does not match the active policy", async () => {
    const quote = await json("/v1/attestation/quote");
    const session = await json("/v1/session", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ ...quote.body, tcbVersion: (quote.body.tcbVersion as number) + 1 }),
    });
    expect(session.status).toBe(403);
  });

  it("records a new TCB policy version without breaking the live serving image", async () => {
    const before = await json("/v1/tcb/policies");
    expect(before.body.active.version).toBe(1);
    const rotated = await json("/v1/tcb/rotate", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ servingImageId: "enclave-echo-v1" }),
    });
    expect(rotated.status).toBe(201);
    expect(rotated.body.recorded.version).toBeGreaterThan(1);
    expect(rotated.body.servingUnchanged).toBe(true);
    const after = await json("/v1/tcb/policies");
    expect(after.body.history.some((row: { version: number }) => row.version === rotated.body.recorded.version)).toBe(true);
    expect(after.body.active.version).toBe(1);
  });

  it("runs stake → list model → agent infer → hash-only receipt → view-key usage export → buyback", async () => {
    const stake = await json("/v1/stake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ amountWei: (10n ** 18n).toString() }),
    });
    expect(stake.status).toBe(200);
    expect(BigInt(stake.body.staked as string)).toBeGreaterThan(0n);

    const listed = await json("/v1/marketplace/list", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        modelHash: sha256Hex(`model:d89:${Date.now()}`),
        codeHash: sha256Hex(`code:d89:${Date.now()}`),
        version: "d89-v1",
        bps: 250,
      }),
    });
    expect(listed.status).toBe(201);
    expect(listed.body.approved).toBe(false);
    const listingId = listed.body.listingId as number;
    const approved = await json(`/v1/marketplace/${listingId}/bootstrap-approve`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.approved).toBe(true);

    const agent = await json("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ name: "glue-bot", dailyLimitUsdc: 50 }),
    });
    expect(agent.status).toBe(201);
    const infer = await paidInfer(agent.body.id as string, "glue prompt");

    const publicReceipt = await json(`/v1/receipts/${infer.typedHash}`);
    expect(publicReceipt.status).toBe(200);
    expect(isHashOnlyReceipt(publicReceipt.body)).toBe(true);
    expect(publicReceipt.body.sig).toBeUndefined();
    expect(publicReceipt.body.amountUnits).toBeUndefined();

    const issued = await json("/v1/compliance/view-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ label: "glue-auditor" }),
    });
    const secret = issued.body.secret as string;
    const stranger = await json("/v1/compliance/export", { headers: { "x-view-key": "nope" } });
    expect(stranger.status).toBe(403);

    const exported = await json("/v1/compliance/export", { headers: { "x-view-key": secret } });
    expect(exported.status).toBe(200);
    expect(Number(exported.body.usage.usdcUnits)).toBeGreaterThan(0);
    expect(exported.body.usage.calls).toBeGreaterThan(0);
    expect(exported.body.receipts.some((row: { typedHash: string; sig?: string }) => row.typedHash === infer.typedHash && Boolean(row.sig))).toBe(true);

    const auditorReceipt = await json(`/v1/receipts/${infer.typedHash}`, { headers: { "x-view-key": secret } });
    expect(auditorReceipt.status).toBe(200);
    expect(auditorReceipt.body.sig).toBeTruthy();

    const reserved = await json("/v1/buyback/reserve", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ treasuryBps: 1000 }),
    });
    expect(reserved.status).toBe(200);
    const distributed = await json("/v1/fees/distribute", {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });
    expect(distributed.status).toBe(200);
    expect(distributed.body.buyback).toBeTruthy();
    expect(BigInt(distributed.body.buyback.amountUnits as string)).toBeGreaterThan(0n);

    const buybacks = await json("/v1/buyback", { headers: { "x-api-key": apiKey } });
    expect(buybacks.status).toBe(200);
    expect(buybacks.body.length).toBeGreaterThan(0);
    expect(buybacks.body[0].status).toBe("reserved");
  });
});
