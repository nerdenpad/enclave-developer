import { config as loadDotenv } from "dotenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptAesGcm, isHashOnlyPayment, sha256Hex } from "@enclave/core";
import { apiKeys, createDb } from "@enclave/db";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { EnclaveGateway } from "./gateway.js";
import { createLogger } from "./logger.js";
import { createMarketplace, marketplaceConfigured } from "./chain.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("pdf backend remainder", () => {
  const apiKey = `enclave_pdf_${Date.now()}`;
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
    await db.insert(apiKeys).values({ keyHash: sha256Hex(apiKey), role: "admin", label: "e2e-pdf", usdcBalance: 0n });
    gateway = await EnclaveGateway.boot(db, cfg, log, undefined);
    app = createApp(gateway, log);
    const tools = await json("/v1/agent-sdk/tools");
    expect(tools.status).toBe(200);
    const quote = await json("/v1/agent-sdk/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ tool: "enclave_quote", input: {} }),
    });
    const session = await json("/v1/agent-sdk/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ tool: "enclave_session", input: quote.body }),
    });
    expect(session.status).toBe(201);
    sessionId = session.body.sessionId as string;
    wrapKey = Buffer.from(session.body.wrapKey as string, "base64");
  }, 30_000);

  afterAll(async () => {
    await gateway?.restoreServingModel(apiKey).catch(() => undefined);
    await sql.end({ timeout: 5 });
  });

  it("hides confidential payment amounts unless a view-key is presented", async () => {
    const blob = encryptAesGcm(wrapKey, Buffer.from("pdf-prompt"));
    const unpaid = await json("/v1/agent-sdk/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ tool: "enclave_infer", input: { sessionId, ...blob } }),
    });
    expect(unpaid.status).toBe(402);
    const paymentId = unpaid.body.details.accepts[0].extra.paymentId as string;
    const settled = await json("/v1/agent-sdk/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ tool: "enclave_settle", input: { paymentId, confidential: true } }),
    });
    expect(settled.status).toBe(200);
    expect(settled.body.confidential).toBe(true);

    const pub = await json(`/v1/payments/${paymentId}`);
    expect(pub.status).toBe(200);
    expect(isHashOnlyPayment(pub.body)).toBe(true);
    expect(pub.body.amountUnits).toBeUndefined();

    const issued = await json("/v1/compliance/view-keys", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ label: "pdf-auditor" }),
    });
    const secret = issued.body.secret as string;
    const auditor = await json(`/v1/payments/${paymentId}`, { headers: { "x-view-key": secret } });
    expect(auditor.status).toBe(200);
    expect(Number(auditor.body.amountUnits)).toBeGreaterThan(0);
  });

  it("lists a model by staking ENCL and rejects a chain-revoked serving image within the next call", async () => {
    const listed = await json("/v1/marketplace/list", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({
        modelHash: sha256Hex(`model:pdf:${Date.now()}`),
        codeHash: sha256Hex(`code:pdf:${Date.now()}`),
        version: "pdf-v1",
        bps: 100,
      }),
    });
    expect(listed.status).toBe(201);
    expect(listed.body.listingId).toBeGreaterThan(0);

    const cfg = loadConfig();
    if (!marketplaceConfigured(cfg)) {
      return;
    }
    const market = createMarketplace(cfg);
    await market.revoke(1n);
    const blob = encryptAesGcm(wrapKey, Buffer.from("revoked"));
    const denied = await json("/v1/inference", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ sessionId, ...blob }),
    });
    expect(denied.status).toBe(403);
    expect(denied.body.title).toBe("MODEL_NOT_APPROVED");
    await market.bootstrapRestore(1n);
  });
});
