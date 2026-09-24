import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createDb, apiKeys, mandates } from "@enclave/db";
import { sha256Hex } from "@enclave/core";

// Explicit local pilot administration only; never runs during service startup.
if (process.env.ARC_CHAIN_ID !== "31337" || process.env.TEE_MODE !== "dev" || process.env.PAYMENT_MODE !== "mock") {
  throw new Error("Pilot client provisioning requires development chain and mock payments.");
}
const destination = "data/demo/pilot-client.env";
if (existsSync(destination)) throw new Error("A pilot client already exists; credentials and budgets were left unchanged.");
const secret = `enclave_pilot_${randomBytes(32).toString("hex")}`;
const keyHash = sha256Hex(secret);
const connection = createDb(process.env.DATABASE_URL!);
try {
  await connection.db.transaction(async (tx) => {
    await tx.insert(apiKeys).values({ keyHash, label: "pilot-owner", role: "user", usdcBalance: 0n });
    await tx.insert(mandates).values({ agent: keyHash, dailyLimitUnits: 1_000_000n, spentTodayUnits: 0n,
      dayKey: new Date().toISOString().slice(0, 10), lane: "prefunded" });
    writeFileSync(destination, `PILOT_API_KEY=${secret}\n`, { flag: "wx", mode: 0o600 });
  });
  console.log("Pilot user created with no administrator privileges and a daily limit of 1 test USDC. Credential stored in private runtime state.");
} finally { await connection.sql.end({ timeout: 5 }); }
