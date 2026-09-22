import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z } from "zod";
import { AppError } from "@enclave/core";
import type { EnclaveGateway } from "./gateway.js";

export type TrpcContext = {
  gateway: EnclaveGateway;
  apiKey: string;
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

function mapError(err: unknown): never {
  if (err instanceof AppError) {
    const code =
      err.statusCode === 401
        ? "UNAUTHORIZED"
        : err.statusCode === 403
          ? "FORBIDDEN"
          : err.statusCode === 404
            ? "NOT_FOUND"
            : err.statusCode === 409
              ? "CONFLICT"
        : err.statusCode === 402
          ? "PRECONDITION_FAILED"
          : err.statusCode === 400
            ? "BAD_REQUEST"
            : "INTERNAL_SERVER_ERROR";
    throw new TRPCError({ code, message: err.message, cause: err });
  }
  throw err;
}

export const appRouter = t.router({
  vault: t.router({
    quoteMint: t.procedure
      .input(z.object({ asset: z.string() }).optional())
      .query(async ({ ctx }) => {
        try {
          return { quote: await ctx.gateway.quote(), priceUsdc: ctx.gateway.inferencePriceUsdc() };
        } catch (err) {
          mapError(err);
        }
      }),
    solvency: t.procedure.input(z.object({ asset: z.string() })).query(async ({ ctx, input }) => {
      try {
        return await ctx.gateway.solvency(input.asset);
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  inference: t.router({
    quote: t.procedure.query(async ({ ctx }) => {
      try {
        return await ctx.gateway.quote();
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  buffer: t.router({
    state: t.procedure.input(z.object({ asset: z.string() })).query(async ({ ctx, input }) => {
      try {
        return await ctx.gateway.solvency(input.asset);
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  stats: t.router({
    models: t.procedure.query(async ({ ctx }) => {
      try {
        return await ctx.gateway.listModels();
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  agents: t.router({
    list: t.procedure.query(async ({ ctx }) => {
      try {
        return await ctx.gateway.listAgents(ctx.apiKey);
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  stake: t.router({
    status: t.procedure.query(async ({ ctx }) => {
      try {
        return await ctx.gateway.stakeStatus(ctx.apiKey);
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  tcb: t.router({
    policies: t.procedure.query(async ({ ctx }) => {
      try {
        return await ctx.gateway.listTcbPolicies();
      } catch (err) {
        mapError(err);
      }
    }),
  }),
  agentSdk: t.router({
    tools: t.procedure.query(({ ctx }) => ctx.gateway.agentSdkTools()),
  }),
});

export type AppRouter = typeof appRouter;
