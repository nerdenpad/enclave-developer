import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerServingModel, registrationOptions } from "./register-serving-model.js";

const model = "Qwen/Qwen2.5-3B-Instruct";
const codeHash = `0x${"12".repeat(32)}`;
const expectedHash = "0x20a25bdbc7b577aa5fed0d79ab3ca27c2f56f711c328683237361dbc2d3e001e";
let server: Server;
let base: string;
let catalog: Array<Record<string, unknown>>;
let state: string;
let chainId: number;
let calls: Array<{ route: string; method: string; key?: string; body?: Record<string, unknown> }>;
let rejectApproval: boolean;
let redirectApproval: boolean;

beforeEach(async () => {
  catalog = [];
  state = "pending";
  chainId = 31337;
  calls = [];
  rejectApproval = false;
  redirectApproval = false;
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : undefined;
    const route = req.url!;
    calls.push({ route, method: req.method!, key: req.headers["x-api-key"] as string | undefined, body });
    res.setHeader("content-type", "application/json");
    if (route === "/health") res.end(JSON.stringify({ chainId, teeMode: "dev" }));
    else if (route === "/v1/attestation/quote") res.end(JSON.stringify({ measurement: codeHash }));
    else if (route === "/v1/marketplace") res.end(JSON.stringify(catalog));
    else if (route === "/v1/marketplace/list") {
      const row = { ...body, listingId: 7, approved: false, revoked: false };
      catalog.push(row);
      res.statusCode = 201;
      res.end(JSON.stringify(row));
    } else if (route === "/v1/marketplace/7/approval") res.end(JSON.stringify({ state, availableAt: "4600" }));
    else if (["/v1/marketplace/7/approve", "/v1/marketplace/7/bootstrap-approve"].includes(route)) {
      if (redirectApproval) { res.statusCode = 307; res.setHeader("location", `${base}/must-not-receive-admin-key`); res.end("{}"); }
      else if (rejectApproval) { res.statusCode = 403; res.end(JSON.stringify({ detail: "secret-token-should-not-leak" })); }
      else { state = "approved"; catalog[0]!.approved = true; res.end(JSON.stringify({ approved: true })); }
    } else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

function options(args: string[] = []) {
  return registrationOptions({ API_BASE: base, INFERENCE_MODEL: model, ENCLAVE_API_KEY: "local-test-admin" }, args);
}
function existing(approved = false, revoked = false) { catalog = [{ modelHash: expectedHash, codeHash, listingId: 7, approved, revoked, listingBps: 250 }]; }

describe("local serving model registration", () => {
  it("defaults to public reads without listing deposits, approval or inference", async () => {
    const result = await registerServingModel(options(["--bootstrap"]));
    expect(result).toMatchObject({ mode: "dry-run", model, modelHash: expectedHash, codeHash, state: "unlisted" });
    expect(calls.every((call) => call.method === "GET" && call.key === undefined)).toBe(true);
    expect(catalog).toEqual([]);
    expect(result.actions.join(" ")).toContain("bootstrap-approve");
  });

  it("registers the exact Qwen/active code pair and explicitly bootstraps only that listing", async () => {
    const result = await registerServingModel(options(["--apply", "--bootstrap"]));
    expect(result).toMatchObject({ state: "approved", listingId: 7, modelHash: expectedHash, codeHash });
    const writes = calls.filter((call) => call.method === "POST");
    expect(writes.map((call) => call.route)).toEqual(["/v1/marketplace/list", "/v1/marketplace/7/bootstrap-approve"]);
    expect(writes[0]!.body).toEqual({ modelHash: expectedHash, codeHash, version: `local:${model}`, bps: 0 });
    expect(writes.every((call) => call.key === "local-test-admin")).toBe(true);
    expect(calls.some((call) => call.route.includes("inference") || call.route.includes("revoke"))).toBe(false);
  });

  it("is a no-op for an already approved pair and preserves its provider fee", async () => {
    existing(true);
    state = "approved";
    expect(await registerServingModel(options(["--apply", "--bootstrap"]))).toMatchObject({ state: "approved", listingId: 7, actions: [] });
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    expect(catalog[0]!.listingBps).toBe(250);
  });

  it("creates a pending listing but respects the timelock without --bootstrap", async () => {
    expect(await registerServingModel(options(["--apply"]))).toMatchObject({ state: "pending", listingId: 7, availableAt: "4600" });
    expect(calls.filter((call) => call.method === "POST").map((call) => call.route)).toEqual(["/v1/marketplace/list"]);
  });

  it("reuses a ready listing and submits regular timed approval", async () => {
    existing();
    state = "ready";
    expect(await registerServingModel(options(["--apply"]))).toMatchObject({ state: "approved" });
    expect(calls.filter((call) => call.method === "POST").map((call) => call.route)).toEqual(["/v1/marketplace/7/approve"]);
  });

  it("repairs stale DB approval through the idempotent regular route", async () => {
    existing();
    state = "approved";
    await registerServingModel(options(["--apply", "--bootstrap"]));
    expect(calls.filter((call) => call.method === "POST").map((call) => call.route)).toEqual(["/v1/marketplace/7/approve"]);
  });

  it.each(["catalog", "chain"])("refuses a revoked %s listing instead of restoring it", async (source) => {
    existing(false, source === "catalog");
    state = source === "chain" ? "revoked" : "pending";
    await expect(registerServingModel(options(["--apply", "--bootstrap"]))).rejects.toThrow("revoked");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("checks actual gateway chain identity before any mutation", async () => {
    chainId = 1;
    await expect(registerServingModel(options(["--apply", "--bootstrap"]))).rejects.toThrow("31337");
    expect(calls.map((call) => call.route)).toEqual(["/health"]);
  });

  it("does not retry a denied approval or print the server's possibly secret error detail", async () => {
    existing();
    rejectApproval = true;
    const failure = await registerServingModel(options(["--apply", "--bootstrap"])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^Local API returned HTTP 403/);
    expect((failure as Error).message).not.toMatch(/local-test-admin|secret-token-should-not-leak/);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("does not follow an approval redirect with the administrator credential", async () => {
    existing();
    redirectApproval = true;
    await expect(registerServingModel(options(["--apply", "--bootstrap"]))).rejects.toThrow("Local API request failed");
    expect(calls.some((call) => call.route === "/must-not-receive-admin-key")).toBe(false);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it.each(["https://example.com", "http://admin:secret@localhost", "http://localhost/?key=secret", "http://localhost/private", "file:///tmp/api"])("rejects unsafe API origin %s", (apiBase) => {
    expect(() => registrationOptions({ INFERENCE_MODEL: model, API_BASE: apiBase }, ["--apply"])).toThrow("API_BASE must be a loopback HTTP(S) origin");
    expect(calls).toHaveLength(0);
  });

  it("requires an explicit model and supports the same environment profile as the gateway", () => {
    expect(() => registrationOptions({}, [])).toThrow("INFERENCE_MODEL");
    expect(registrationOptions({ API_BASE: base, INFERENCE_MODEL: "echo", DEMO_API_KEY: "test-demo" }, ["--model", model])).toMatchObject({ model, apiKey: "test-demo", apply: false });
    expect(() => options(["--model"])).toThrow("Supported arguments");
  });
});
