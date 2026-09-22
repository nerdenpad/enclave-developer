import { describe, expect, it, vi } from "vitest";
import { AppError } from "@enclave/core";
import { appRouter } from "./trpc.js";
import type { EnclaveGateway } from "./gateway.js";

describe("tRPC transport", () => {
  it("uses configured pricing rather than a hard-coded quote", async () => {
    const gateway = { quote: vi.fn().mockResolvedValue({ measurement: "hash" }), inferencePriceUsdc: () => 0.25 } as unknown as EnclaveGateway;
    expect(await appRouter.createCaller({ gateway, apiKey: "owner" }).vault.quoteMint()).toEqual({ quote: { measurement: "hash" }, priceUsdc: 0.25 });
  });
  it("routes all public queries and private stake status with their input", async () => {
    const gateway = {
      solvency: vi.fn().mockResolvedValue({ models: 2 }), listModels: vi.fn().mockResolvedValue(["model"]),
      stakeStatus: vi.fn().mockResolvedValue({ staked: "42" }), listTcbPolicies: vi.fn().mockResolvedValue({ active: 1 }),
      agentSdkTools: vi.fn().mockReturnValue(["tool"]),
    };
    const caller = appRouter.createCaller({ gateway: gateway as unknown as EnclaveGateway, apiKey: "owner" });
    expect(await caller.vault.solvency({ asset: "USDC" })).toEqual({ models: 2 });
    expect(await caller.buffer.state({ asset: "USDC" })).toEqual({ models: 2 });
    expect(await caller.stats.models()).toEqual(["model"]);
    expect(await caller.stake.status()).toEqual({ staked: "42" });
    expect(await caller.tcb.policies()).toEqual({ active: 1 });
    expect(await caller.agentSdk.tools()).toEqual(["tool"]);
    expect(gateway.solvency).toHaveBeenCalledWith("USDC");
    expect(gateway.stakeStatus).toHaveBeenCalledWith("owner");
  });
  it("maps application errors consistently across the remaining routers", async () => {
    const error = new AppError("DENIED", "denied", 403);
    const fail = () => Promise.reject(error);
    const gateway = { quote: fail, solvency: fail, listModels: fail, listAgents: fail, stakeStatus: fail, listTcbPolicies: fail } as unknown as EnclaveGateway;
    const caller = appRouter.createCaller({ gateway, apiKey: "owner" });
    for (const call of [() => caller.vault.quoteMint(), () => caller.vault.solvency({ asset: "USDC" }), () => caller.buffer.state({ asset: "USDC" }), () => caller.stats.models(), () => caller.agents.list(), () => caller.stake.status(), () => caller.tcb.policies()]) {
      await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });
  it("keeps unexpected failures as internal errors", async () => {
    const gateway = { quote: vi.fn().mockRejectedValue(new Error("unexpected")) } as unknown as EnclaveGateway;
    await expect(appRouter.createCaller({ gateway, apiKey: "owner" }).inference.quote()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
  });
  it.each([[400,"BAD_REQUEST"],[401,"UNAUTHORIZED"],[402,"PRECONDITION_FAILED"],[403,"FORBIDDEN"],[404,"NOT_FOUND"],[409,"CONFLICT"],[503,"INTERNAL_SERVER_ERROR"]])("maps async quote error %s", async (status, code) => {
    const gateway = { quote: vi.fn().mockRejectedValue(new AppError("TEST", "failure", Number(status))) } as unknown as EnclaveGateway;
    await expect(appRouter.createCaller({ gateway, apiKey: "owner" }).inference.quote()).rejects.toMatchObject({ code });
  });
  it("forwards caller identity for private agent lists", async () => {
    const listAgents = vi.fn().mockResolvedValue([{ id: "a" }]);
    const gateway = { listAgents } as unknown as EnclaveGateway;
    expect(await appRouter.createCaller({ gateway, apiKey: "owner" }).agents.list()).toEqual([{ id: "a" }]);
    expect(listAgents).toHaveBeenCalledWith("owner");
  });
});
