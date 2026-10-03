import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcceptanceError, acceptanceApiBase, acceptanceOptions, createAcceptanceApi } from "./accept-near-arc.js";

const cliPaths = ["--plan", "reviewed-plan.json", "--state", ".local/acceptance/journal.json"];
const privateToken = "private-wallet-bearer-never-log";
const privateBody = { authorization: "private-payment-authorization-never-log", ciphertext: "private-ciphertext-never-log" };

afterEach(() => vi.restoreAllMocks());

describe("NEAR Arc acceptance command authorization", () => {
  it("defaults to preflight and resolves explicit paths without execution", () => {
    expect(acceptanceOptions(cliPaths)).toEqual({ help: false, mode: "preflight",
      planPath: resolve("reviewed-plan.json"), statePath: resolve(".local/acceptance/journal.json"), envPath: undefined });
    expect(acceptanceOptions(["--help"])).toEqual({ help: true });
  });

  it.each([
    { flags: ["--execute"], mode: "execute" },
    { flags: ["--recover"], mode: "recover" },
    { flags: ["--prepare-manifest"], mode: "prepare-manifest" },
    { flags: ["--unlock-stale"], mode: "unlock-stale" },
    { flags: ["--execute", "--recover-completed"], mode: "recover-completed" },
    { flags: ["--recover-completed", "--execute"], mode: "recover-completed" },
  ])("accepts the explicit $mode mode", ({ flags, mode }) => {
    expect(acceptanceOptions([...cliPaths, ...flags, "--env", "operator.fixture"])).toMatchObject({
      help: false, mode, envPath: resolve("operator.fixture"),
    });
  });

  it.each([
    [], ["--plan"], ["--state", "journal.json"], ["--plan", "plan.json"],
    ["--plan", " ", "--state", "journal.json"], ["--plan", "--execute", "--state", "journal.json"],
    [...cliPaths, "--plan", "another-plan.json"], [...cliPaths, "--state", "another-journal.json"],
    [...cliPaths, "--env", "one.fixture", "--env", "two.fixture"], [...cliPaths, "--env"],
    [...cliPaths, "--execute", "--execute"], [...cliPaths, "--recover", "--recover"],
    [...cliPaths, "--execute", "--recover"], [...cliPaths, "--execute", "--prepare-manifest"],
    [...cliPaths, "--recover", "--prepare-manifest"], [...cliPaths, "--execute", "--recover-completed", "--recover"],
    [...cliPaths, "--unlock-stale", "--unlock-stale"], [...cliPaths, "--unlock-stale", "--execute"],
    [...cliPaths, "--unlock-stale", "--recover"], [...cliPaths, "--unlock-stale", "--prepare-manifest"],
    [...cliPaths, "--unlock-stale", "--recover-completed"], [...cliPaths, "--unlock-stale", "--execute", "--recover-completed"],
    [...cliPaths, "--help"], [...cliPaths, "--send"], [...cliPaths, "unexpected-positional-value"],
  ].map(args => ({ args })))("rejects conflicting, incomplete or unknown arguments %#", ({ args }) => {
    expect(() => acceptanceOptions(args)).toThrow(AcceptanceError);
  });

  it("requires execution authorization before a persisted completion replay", () => {
    expect(() => acceptanceOptions([...cliPaths, "--recover-completed"])).toThrow("EXECUTE_REQUIRED");
  });
});

describe("acceptance API origin boundary", () => {
  it.each([
    ["https://api.example", "https://api.example"],
    ["https://api.example/", "https://api.example"],
    ["https://api.example/api/", "https://api.example/api"],
    ["https://api.example:8443/api", "https://api.example:8443/api"],
    ["http://127.0.0.1:3000/api/", "http://127.0.0.1:3000/api"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://[::1]:3000/api", "http://[::1]:3000/api"],
  ])("permits and normalizes %s", (input, expected) => {
    expect(acceptanceApiBase(input)).toBe(expected);
  });

  it.each([
    "http://api.example/api", "http://localhost.attacker.example", "http://127.0.0.2:3000", "http://[::2]:3000",
    "ftp://api.example", "https://user:private-password@api.example", "https://api.example?token=private-token",
    "https://api.example/#private-token", "https://api.example/api/v1", "https://api.example/another-path",
  ])("rejects credentials, non-loopback HTTP and extra URL components: %s", input => {
    expect(() => acceptanceApiBase(input)).toThrow("API_ORIGIN_INVALID");
  });
});

describe("single-attempt private acceptance HTTP transport", () => {
  it("sends exactly one POST with redirect protection, an abort signal and no browser credentials", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ paymentId: "fixture-payment" }, { status: 200 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = createAcceptanceApi("https://api.example/api/", "", transport);
    await expect(api("/v1/x402/settle", "POST", privateBody, { "x-api-key": privateToken, origin: "https://enclave.example" }))
      .resolves.toEqual({ status: 200, data: { paymentId: "fixture-payment" } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0]).toBe("https://api.example/api/v1/x402/settle");
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: "POST", redirect: "error", credentials: "omit",
      referrerPolicy: "no-referrer", body: JSON.stringify(privateBody),
      headers: { accept: "application/json", "content-type": "application/json", "x-api-key": privateToken, origin: "https://enclave.example" } });
    expect(transport.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("makes GET requests without a JSON body and preserves the status for the caller", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ title: "PAYMENT_REQUIRED" }, { status: 402 }));
    const api = createAcceptanceApi("https://api.example", privateToken, transport);
    await expect(api("/health")).resolves.toEqual({ status: 402, data: { title: "PAYMENT_REQUIRED" } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![1]).toMatchObject({ method: "GET", headers: { "x-api-key": privateToken } });
    expect(transport.mock.calls[0]![1]!.body).toBeUndefined();
    expect(new Headers(transport.mock.calls[0]![1]!.headers).has("content-type")).toBe(false);
  });

  async function expectPrivateFailure(transport: ReturnType<typeof vi.fn<typeof fetch>>) {
    const api = createAcceptanceApi("https://api.example/api", privateToken, transport);
    const failure = await api("/v1/inference", "POST", privateBody).then(() => undefined, error => error as unknown);
    expect(failure).toBeInstanceOf(AcceptanceError);
    expect(failure).toMatchObject({ code: "HTTP_UNCERTAIN", message: "Acceptance failed: HTTP_UNCERTAIN" });
    expect((failure as Error).cause).toBeUndefined();
    const exposed = `${String(failure)} ${JSON.stringify(failure)} ${(failure as Error).stack}`;
    expect(exposed).not.toContain(privateToken);
    expect(exposed).not.toContain(privateBody.authorization);
    expect(exposed).not.toContain(privateBody.ciphertext);
    expect(transport).toHaveBeenCalledTimes(1);
  }

  it("never retries an ambiguous network failure and redacts the underlying exception", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`network failure: ${privateToken} ${JSON.stringify(privateBody)}`))
      .mockResolvedValueOnce(Response.json({ shouldNeverBeRequested: true }));
    await expectPrivateFailure(transport);
  });

  it("never follows or retries a redirect failure", async () => {
    const transport = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error(`redirect to https://attacker.example/?token=${privateToken}`))
      .mockResolvedValueOnce(Response.json({ shouldNeverBeRequested: true }));
    await expectPrivateFailure(transport);
    expect(transport.mock.calls[0]![1]!.redirect).toBe("error");
  });

  it("rejects a transport that reports it followed a redirect", async () => {
    const response = Response.json({ leaked: privateBody });
    Object.defineProperty(response, "redirected", { value: true });
    await expectPrivateFailure(vi.fn<typeof fetch>().mockResolvedValue(response));
  });

  it("redacts a malformed response body instead of exposing parser diagnostics", async () => {
    await expectPrivateFailure(vi.fn<typeof fetch>().mockResolvedValue(new Response(`invalid-json ${privateToken} ${JSON.stringify(privateBody)}`)));
  });

  it("rejects invalid UTF-8 and absent response bodies with the same fixed failure", async () => {
    for (const response of [new Response(Uint8Array.from([0xff, 0xfe])), new Response(null, { status: 204 })]) {
      await expectPrivateFailure(vi.fn<typeof fetch>().mockResolvedValue(response));
    }
  });

  it("rejects a response larger than the transport limit without another POST", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(12_582_913)); controller.close();
    } }));
    await expectPrivateFailure(vi.fn<typeof fetch>().mockResolvedValue(response));
  });

  it("redacts failures while reading a response stream without retrying the completion", async () => {
    let reads = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (reads++ === 0) controller.enqueue(new TextEncoder().encode("{"));
      else controller.error(new Error(`private stream error ${privateToken} ${JSON.stringify(privateBody)}`));
    } }));
    await expectPrivateFailure(vi.fn<typeof fetch>().mockResolvedValue(response));
  });
});
