// Disposable integration-test subprocess: independent pool, signer and JS runtime.
import { readFileSync } from "node:fs";
import { createDb, sendDurableTransaction, confirmDurableTransaction } from "@enclave/db";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
const { db, sql } = createDb(process.env.DATABASE_URL!);
try {
  const opts = { db, rpcUrl: process.env.ARC_RPC_URL!, chainId: Number(process.env.ARC_CHAIN_ID), privateKey: process.env.DEPLOYER_PRIVATE_KEY as Hex };
  const abi = JSON.parse(readFileSync(new URL("../contracts/out-solc/MockUSDC.json", import.meta.url), "utf8")).abi;
  const hash = await sendDurableTransaction(opts, process.argv[2]!, { address: process.env.USDC_ADDRESS as Hex, abi, functionName: "mint", args: [privateKeyToAccount(opts.privateKey).address, BigInt(process.argv[3]!)] });
  await confirmDurableTransaction(opts, hash);
  process.stdout.write(JSON.stringify({ hash }));
} finally { await sql.end(); }
