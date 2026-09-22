import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { AppError, ValidationError } from "@enclave/core";
import type { AgentRuntime } from "./agent-runtime.js";

/** Mount at /v1/agent-runs; this router never exposes runner/lease/key internals. */
export function createAgentRuntimeRoutes(runtime: AgentRuntime) {
  const routes = new Hono();
  routes.use("*", bodyLimit({ maxSize: 32_768, onError: (c) => c.json({ title: "AGENT_REQUEST_TOO_LARGE", status: 413 }, 413) }));
  routes.use("/:id/*", async (c, next) => {
    if (!z.string().uuid().safeParse(c.req.param("id")).success) throw new ValidationError({ id: "Expected UUID" });
    await next();
  });
  routes.use("/:id", async (c, next) => {
    if (!z.string().uuid().safeParse(c.req.param("id")).success) throw new ValidationError({ id: "Expected UUID" });
    await next();
  });
  routes.onError((error, c) => {
    const status = error instanceof AppError ? error.statusCode : 500;
    const title = error instanceof AppError ? error.code : "AGENT_RUNTIME_ERROR";
    return c.json({ type: "about:blank", title, status }, status as 400);
  });
  routes.post("/", async (c) => {
    let input: unknown; try { input = await c.req.json(); } catch { throw new ValidationError({ body: "Invalid JSON" }); }
    return c.json(await runtime.create(c.req.header("x-api-key") ?? "", input), 201);
  });
  routes.get("/", async (c) => c.json(await runtime.list(c.req.header("x-api-key") ?? "", c.req.query("after"), c.req.query("limit") === undefined ? 50 : Number(c.req.query("limit")))));
  routes.get("/:id", async (c) => c.json(await runtime.get(c.req.header("x-api-key") ?? "", c.req.param("id"),
    c.req.query("sessionId") ? { sessionId: c.req.query("sessionId")! } : {})));
  routes.post("/:id/cancel", async (c) => c.json(await runtime.cancel(c.req.header("x-api-key") ?? "", c.req.param("id"))));
  routes.post("/:id/resume", async (c) => {
    let input: unknown; try { input = await c.req.json(); } catch { throw new ValidationError({ body: "Invalid JSON" }); }
    return c.json(await runtime.resume(c.req.header("x-api-key") ?? "", c.req.param("id"), input));
  });
  return routes;
}
