import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { trpcServer } from "@hono/trpc-server";
import { z } from "zod";
import { AppError, NotFoundError, PaymentRequiredError, ValidationError } from "@enclave/core";
import type { EnclaveGateway } from "./gateway.js";
import { appRouter } from "./trpc.js";
import type { Logger } from "./logger.js";
import { createX402Routes } from "./x402-routes.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { createAgentRuntimeRoutes } from "./agent-runtime-routes.js";

import { QuoteBody, InferBody, SettleBody, AgentBody, MemoryBody, StakeBody, ListModelBody, ViewKeyBody, TcbRotateBody, AgentSdkInvokeBody } from "./validation.js";
import { BuybackConfigBody, BuybackReserveBody, BuybackExecuteBody } from "./validation.js";

function paymentIdFromRequest(header: string | undefined, bodyPaymentId?: string): string | undefined {
  if (bodyPaymentId) {
    return bodyPaymentId;
  }
  if (!header) {
    return undefined;
  }
  let value: unknown = header;
  try {
    const parsed: unknown = JSON.parse(header);
    const payload = z.object({ paymentId: z.string().optional(), extra: z.object({ paymentId: z.string().optional() }).optional() }).safeParse(parsed);
    value = payload.success ? payload.data.paymentId ?? payload.data.extra?.paymentId : undefined;
  } catch { /* A raw UUID is the other supported transport. */ }
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new ValidationError({ paymentId: "Expected a UUID payment token" });
  return parsed.data;
}

function problem(err: AppError) {
  return {
    type: `https://enclave.local/errors/${err.code}`,
    title: err.code,
    status: err.statusCode,
    detail: err.message,
    details: err.details,
  };
}

async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); }
  catch { throw new ValidationError({ body: "Invalid JSON" }); }
}

export function createApp(gateway: EnclaveGateway, log: Logger, agentRuntime?: AgentRuntime) {
  const app = new Hono();
  app.use("*", cors());
  app.use("/v1/payments/:id", async (c, next) => {
    if (!z.string().uuid().safeParse(c.req.param("id")).success) throw new ValidationError({ id: "Expected UUID" });
    await next();
  });
  app.use("/v1/agents/:id/*", async (c, next) => {
    if (!z.string().uuid().safeParse(c.req.param("id")).success) throw new ValidationError({ id: "Expected UUID" });
    await next();
  });
  app.use("/v1/agents/:id", async (c, next) => {
    if (!z.string().uuid().safeParse(c.req.param("id")).success) throw new ValidationError({ id: "Expected UUID" });
    await next();
  });
  app.use("/v1/marketplace/:id/:action", async (c, next) => {
    if (!z.coerce.number().int().positive().max(2147483647).safeParse(c.req.param("id")).success) throw new ValidationError({ id: "Expected positive listing id" });
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof PaymentRequiredError) {
      return c.json(problem(err), 402);
    }
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        log.error({ err, path: c.req.path }, "server_error");
      } else {
        log.warn({ code: err.code, path: c.req.path }, "client_error");
      }
      return c.json(problem(err), err.statusCode as 400);
    }
    log.error({ err, path: c.req.path }, "unhandled_error");
    return c.json(
      { type: "about:blank", title: "INTERNAL", status: 500, detail: "Internal error" },
      500,
    );
  });

  app.get("/health", (c) => { c.header("Cache-Control", "no-store"); return c.json(gateway.health()); });
  app.get("/v1/workspace", async (c) => {
    c.header("Cache-Control", "no-store");
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(),
      receiptsBefore: z.string().uuid().optional(), paymentsBefore: z.string().uuid().optional(), agentsBefore: z.string().uuid().optional(),
    }).strict().safeParse(c.req.query());
    if (!parsed.success) throw new ValidationError({ pagination: "Expected limit 1..100 and UUID cursors" });
    return c.json(await gateway.workspace(c.req.header("x-api-key") ?? "", parsed.data));
  });
  app.route("/v2", createX402Routes(gateway));
  if (agentRuntime) app.route("/v1/agent-runs", createAgentRuntimeRoutes(agentRuntime));

  app.get("/v1/attestation/quote", async (c) => {
    const quote = await gateway.quote();
    return c.json(quote);
  });

  app.post("/v1/session", async (c) => {
    const apiKey = c.req.header("x-api-key") ?? "";
    const parsed = QuoteBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    const session = await gateway.openSession(apiKey, {
      ...parsed.data,
      measurement: parsed.data.measurement as `0x${string}`,
      signature: parsed.data.signature as `0x${string}`,
    });
    const wrapKey = (await gateway.sessionWrapKeyForOwner(apiKey, session.sessionId)).toString("base64");
    return c.json({ ...session, wrapKey }, 201);
  });

  app.post("/v1/inference", async (c) => {
    const apiKey = c.req.header("x-api-key") ?? "";
    const parsed = InferBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    const result = await gateway.infer({
      apiKey,
      sessionId: parsed.data.sessionId,
      blob: {
        iv: parsed.data.iv,
        tag: parsed.data.tag,
        ciphertext: parsed.data.ciphertext,
      },
      paymentId: paymentIdFromRequest(c.req.header("x-payment"), parsed.data.paymentId),
      idempotencyKey: c.req.header("idempotency-key") ?? undefined,
      agentId: parsed.data.agentId,
    });
    return c.json({
      receipt: {
        ...result.receipt,
        ts: result.receipt.ts.toString(),
      },
      typedHash: result.typedHash,
      outputHash: result.outputHash,
      output: result.output,
      ...(result.providerEvidence ? { providerEvidence: result.providerEvidence } : {}),
    });
  });

  app.post("/v1/x402/settle", async (c) => {
    const apiKey = c.req.header("x-api-key") ?? "";
    const parsed = SettleBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(await gateway.settlePayment(apiKey, parsed.data.paymentId, parsed.data.confidential ?? false, parsed.data.authorization));
  });

  app.get("/v1/payments/:id/authorization", async (c) => {
    const id = z.string().uuid().safeParse(c.req.param("id"));
    const from = z.string().regex(/^0x[0-9a-fA-F]{40}$/).safeParse(c.req.query("from"));
    if (!id.success || !from.success) throw new ValidationError({ authorization: "Expected payment UUID and payer address" });
    return c.json(await gateway.paymentAuthorization(c.req.header("x-api-key") ?? "", id.data, from.data as `0x${string}`));
  });

  app.get("/v1/chain/events", async (c) => {
    const parsedLimit = z.coerce.number().int().min(1).max(100).safeParse(c.req.query("limit") ?? "25");
    if (!parsedLimit.success) throw new ValidationError({ limit: "Expected integer from 1 to 100" });
    const events = await gateway.listChainEvents(parsedLimit.data);
    return c.json(
      events.map((row) => ({
        ...row,
        blockNumber: row.blockNumber.toString(),
      })),
    );
  });

  app.get("/v1/receipts/:typedHash", async (c) => {
    const typedHash = c.req.param("typedHash");
    const viewKey = c.req.header("x-view-key");
    if (viewKey) {
      const exported = await gateway.exportWithViewKey(viewKey);
      const match = exported.receipts.find((row) => row.typedHash === typedHash);
      if (!match) {
        throw new NotFoundError("receipt", typedHash);
      }
      return c.json(match);
    }
    return c.json(await gateway.getPublicReceipt(typedHash));
  });

  app.get("/v1/payments/:id", async (c) => {
    const paymentId = c.req.param("id");
    const viewKey = c.req.header("x-view-key");
    if (viewKey) {
      const exported = await gateway.exportWithViewKey(viewKey);
      const match = exported.payments.find((row) => row.id === paymentId);
      if (!match) {
        throw new NotFoundError("payment", paymentId);
      }
      return c.json(match);
    }
    return c.json(await gateway.getPublicPayment(paymentId));
  });

  app.get("/v1/agent-sdk/tools", (c) => c.json(gateway.agentSdkTools()));

  app.post("/v1/agent-sdk/invoke", async (c) => {
    const parsed = AgentSdkInvokeBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    const result = await gateway.invokeAgentTool(
      c.req.header("x-api-key") ?? "",
      parsed.data.tool,
      parsed.data.input,
    );
    if (parsed.data.tool === "enclave_session") {
      return c.json(result, 201);
    }
    return c.json(result);
  });

  app.get("/v1/models", async (c) => c.json(await gateway.listModels()));

  app.get("/v1/solvency/:asset", async (c) => {
    return c.json(await gateway.solvency(c.req.param("asset")));
  });

  app.post("/v1/agents", async (c) => {
    const apiKey = c.req.header("x-api-key") ?? "";
    const parsed = AgentBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    const memory =
      parsed.data.iv && parsed.data.tag && parsed.data.ciphertext
        ? { iv: parsed.data.iv, tag: parsed.data.tag, ciphertext: parsed.data.ciphertext }
        : undefined;
    return c.json(
      await gateway.createAgent({
        apiKey,
        name: parsed.data.name,
        dailyLimitUsdc: parsed.data.dailyLimitUsdc,
        allowedModels: parsed.data.allowedModels,
        sessionId: parsed.data.sessionId,
        memory,
      }),
      201,
    );
  });

  app.get("/v1/agents", async (c) => c.json(await gateway.listAgents(c.req.header("x-api-key") ?? "")));

  app.get("/v1/agents/:id", async (c) => c.json(await gateway.getAgent(c.req.header("x-api-key") ?? "", c.req.param("id"))));

  app.post("/v1/agents/:id/memory", async (c) => {
    const parsed = MemoryBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(
      await gateway.putAgentMemory({
        apiKey: c.req.header("x-api-key") ?? "",
        agentId: c.req.param("id"),
        sessionId: parsed.data.sessionId,
        blob: { iv: parsed.data.iv, tag: parsed.data.tag, ciphertext: parsed.data.ciphertext },
      }),
    );
  });

  app.post("/v1/stake", async (c) => {
    const parsed = StakeBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(await gateway.stakeEncl(c.req.header("x-api-key") ?? "", BigInt(parsed.data.amountWei)));
  });

  app.post("/v1/unstake", async (c) => {
    const parsed = StakeBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(await gateway.unstakeEncl(c.req.header("x-api-key") ?? "", BigInt(parsed.data.amountWei)));
  });

  app.get("/v1/stake", async (c) => c.json(await gateway.stakeStatus(c.req.header("x-api-key") ?? "")));

  app.get("/v1/fees/split", async (c) => {
    const parsedAmount = z.string().regex(/^\d{1,78}$/).safeParse(c.req.query("amount") ?? "1000000");
    if (!parsedAmount.success) throw new ValidationError({ amount: "Expected nonnegative integer" });
    const amount = BigInt(parsedAmount.data);
    return c.json(await gateway.feeSplitPreview(c.req.header("x-api-key") ?? "", amount));
  });

  app.post("/v1/fees/distribute", async (c) =>
    c.json(await gateway.distributeFees(c.req.header("x-api-key") ?? "")),
  );

  app.get("/v1/buyback", async (c) => c.json(await gateway.listBuybacks(c.req.header("x-api-key") ?? "")));

  app.get("/v1/stake/rewards", async (c) => c.json(await gateway.stakingRewards(c.req.header("x-api-key") ?? "")));
  app.post("/v1/stake/rewards/claim", async (c) => c.json(await gateway.claimStakingRewards(c.req.header("x-api-key") ?? "")));
  app.get("/v1/buyback/status", async (c) => c.json(await gateway.buybackStatus(c.req.header("x-api-key") ?? "")));
  app.post("/v1/buyback/configure", async (c) => {
    const parsed = BuybackConfigBody.safeParse(await readJson(c));
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    return c.json(await gateway.configureBuyback(c.req.header("x-api-key") ?? "", parsed.data));
  });
  app.post("/v1/buyback/reserve", async (c) => {
    const parsed = BuybackReserveBody.safeParse(await readJson(c));
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    return c.json(await gateway.setBuybackReserve(c.req.header("x-api-key") ?? "", parsed.data.treasuryBps));
  });
  app.post("/v1/buyback/execute", async (c) => {
    const parsed = BuybackExecuteBody.safeParse(await readJson(c));
    if (!parsed.success) throw new ValidationError(parsed.error.flatten());
    return c.json(await gateway.executeBuyback(c.req.header("x-api-key") ?? "", {
      amountUnits: BigInt(parsed.data.amountUnits), minOut: BigInt(parsed.data.minOut), deadline: BigInt(parsed.data.deadline),
    }));
  });

  app.get("/v1/tcb/policies", async (c) => { c.header("Cache-Control", "no-store"); return c.json(await gateway.listTcbPolicies()); });

  app.post("/v1/tcb/rotate", async (c) => {
    const parsed = TcbRotateBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(
      await gateway.rotateTcbPolicy(c.req.header("x-api-key") ?? "", parsed.data.servingImageId, {
        ...(parsed.data.version === undefined ? {} : { version: parsed.data.version }),
        ...(c.req.header("idempotency-key") ? { idempotencyKey: c.req.header("idempotency-key")! } : {}),
      }),
      201,
    );
  });

  app.post("/v1/tcb/:version/activate", async (c) => {
    const version = z.coerce.number().int().min(1).max(2_147_483_647).safeParse(c.req.param("version"));
    const body = z.object({ expectedActiveVersion: z.number().int().min(1).max(2_147_483_647) }).strict().safeParse(await readJson(c));
    if (!version.success || !body.success) throw new ValidationError({ policy: "Expected policy version and expectedActiveVersion" });
    return c.json(await gateway.activateTcbPolicy(c.req.header("x-api-key") ?? "", version.data, body.data.expectedActiveVersion,
      c.req.header("idempotency-key")));
  });

  app.get("/v1/marketplace", async (c) => c.json(await gateway.listMarketplace()));

  app.post("/v1/marketplace/list", async (c) => {
    const parsed = ListModelBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(await gateway.listModel({ apiKey: c.req.header("x-api-key") ?? "", ...parsed.data,
      ...(c.req.header("idempotency-key") ? { idempotencyKey: c.req.header("idempotency-key")! } : {}),
    }), 201);
  });

  app.post("/v1/marketplace/:id/approve", async (c) =>
    c.json(await gateway.approveListing(c.req.header("x-api-key") ?? "", Number(c.req.param("id")))),
  );

  app.get("/v1/marketplace/:id/approval", async (c) => c.json(await gateway.listingApprovalStatus(Number(c.req.param("id")))));
  app.post("/v1/marketplace/:id/bootstrap-approve", async (c) =>
    c.json(await gateway.bootstrapApproveListing(c.req.header("x-api-key") ?? "", Number(c.req.param("id")))),
  );

  app.post("/v1/marketplace/:id/revoke", async (c) =>
    c.json(await gateway.revokeListing(c.req.header("x-api-key") ?? "", Number(c.req.param("id")))),
  );

  app.post("/v1/compliance/view-keys", async (c) => {
    const parsed = ViewKeyBody.safeParse(await readJson(c));
    if (!parsed.success) {
      throw new ValidationError(parsed.error.flatten());
    }
    return c.json(await gateway.issueViewKey(c.req.header("x-api-key") ?? "", parsed.data.label), 201);
  });

  app.get("/v1/compliance/export", async (c) => {
    const secret = c.req.header("x-view-key") ?? "";
    return c.json(await gateway.exportWithViewKey(secret));
  });

  app.use(
    "/trpc/*",
    trpcServer({
      router: appRouter,
      createContext: (_opts, c) => ({
        gateway,
        apiKey: c.req.header("x-api-key") ?? "",
      }),
    }),
  );

  return app;
}
