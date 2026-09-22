import "dotenv/config";
import { createDb } from "@enclave/db";
import { resetChainIndexer } from "../apps/worker/src/indexer.js";
import pino from "pino";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const { db, sql } = createDb(process.env.DATABASE_URL);
try {
  await resetChainIndexer({ db, rpcUrl: process.env.ARC_RPC_URL ?? "http://127.0.0.1:8545", chainId: Number(process.env.ARC_CHAIN_ID ?? 31337),
    verifier: process.env.ATTESTATION_VERIFIER_ADDRESS, meter: process.env.USAGE_METER_ADDRESS,
    feeVault: process.env.FEE_VAULT_ADDRESS, registry: process.env.MODEL_REGISTRY_ADDRESS,
    ...(process.env.CHAIN_DEPLOYMENT_ID ? { deploymentId: process.env.CHAIN_DEPLOYMENT_ID } : {}), log: pino(),
  });
  console.log("Current chain scope reset. Restart the worker to replay confirmed events; serving remains quarantined until replay finishes.");
} finally { await sql.end(); }
