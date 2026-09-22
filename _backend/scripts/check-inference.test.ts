import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkInference, loadInferenceEnvironment } from "./check-inference.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(async (directory) => {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith("enclave-check-fixture-")) throw new Error("Unexpected fixture cleanup path");
    await rm(absolute, { recursive: true, force: true });
  }));
});

describe("development inference check", () => {
  it("matches API precedence: explicit environment, then overlay, then base settings", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "enclave-check-fixture-")); directories.push(directory);
    const overlay = path.join(directory, "modal.fixture"); const base = path.join(directory, "base.fixture");
    await writeFile(base, "INFERENCE_BACKEND=echo\nINFERENCE_MODEL=base-model\nINFERENCE_TIMEOUT_MS=30000\nDATABASE_URL=postgres://fixture\n");
    await writeFile(overlay, "INFERENCE_BACKEND=openai-compatible\nINFERENCE_MODEL=modal-model\nINFERENCE_HEALTH_PATH=/health\nINFERENCE_TIMEOUT_MS=300000\n");
    const env = loadInferenceEnvironment({ INFERENCE_MODEL: "explicit-model" }, [overlay, base]);
    expect(env).toEqual({ INFERENCE_BACKEND: "openai-compatible", INFERENCE_MODEL: "explicit-model", INFERENCE_HEALTH_PATH: "/health", INFERENCE_TIMEOUT_MS: "300000", DATABASE_URL: "postgres://fixture" });
    expect(loadInferenceEnvironment({ INFERENCE_BACKEND: "echo" }, [overlay, base]).INFERENCE_BACKEND).toBe("echo");
    expect(await readFile(overlay, "utf8")).toContain("INFERENCE_MODEL=modal-model");
  });

  it("supports base configuration when no optional overlay exists", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "enclave-check-fixture-")); directories.push(directory);
    const base = path.join(directory, "base.fixture"); await writeFile(base, "INFERENCE_MODEL=local-model\n");
    expect(loadInferenceEnvironment({}, [path.join(directory, "missing.fixture"), base])).toEqual({ INFERENCE_MODEL: "local-model" });
  });

  it("warms the origin before exactly one tiny inference and prints neither token nor output", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "PRIVATE RESPONSE" } }] }));
    vi.stubGlobal("fetch", request);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await checkInference({ INFERENCE_BACKEND: "openai-compatible", TEE_MODE: "dev", INFERENCE_BASE_URL: "https://gpu.example.modal.run/v1", INFERENCE_MODEL: "test-model", INFERENCE_ALLOW_REMOTE: "true",
      INFERENCE_API_KEY: "fixture-secret", INFERENCE_HEALTH_PATH: "/health", INFERENCE_TIMEOUT_MS: "300000" });
    expect(request.mock.calls.map(([url, options]) => [String(url), options?.method])).toEqual([
      ["https://gpu.example.modal.run/health", "GET"], ["https://gpu.example.modal.run/v1/chat/completions", "POST"],
    ]);
    expect(JSON.parse(request.mock.calls[1]![1]!.body as string).max_tokens).toBe(32);
    const printed = JSON.stringify(output.mock.calls);
    expect(printed).toContain("outputBytes");
    expect(printed).not.toContain("fixture-secret");
    expect(printed).not.toContain("PRIVATE RESPONSE");
  });

  it.each([{}, { INFERENCE_BACKEND: "openai-compatible", INFERENCE_BASE_URL: "https://gpu.example/v1", INFERENCE_MODEL: "model", INFERENCE_ALLOW_REMOTE: "yes" }])("rejects incomplete or invalid explicit configuration before a request %#", async (env) => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(checkInference(env)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([{ INFERENCE_BACKEND: "echo" }, { TEE_MODE: "phala" }, { NODE_ENV: "production" }, { NODE_ENV: "staging" }])("refuses configuration inconsistent with the development API %#", async (override) => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    await expect(checkInference({ INFERENCE_BACKEND: "openai-compatible", TEE_MODE: "dev", NODE_ENV: "development", INFERENCE_BASE_URL: "https://gpu.example/v1",
      INFERENCE_MODEL: "model", INFERENCE_ALLOW_REMOTE: "true", INFERENCE_API_KEY: "fixture-key", ...override })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
