import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Abi, type Address } from "viem";
import { foundry } from "viem/chains";
import { describe, expect, it } from "vitest";
import { createFacilitator, meterConfigured, paymentIdToBytes32 } from "./chain.js";
import { loadConfig } from "./config.js";

describe("independent payments using the shared facilitator wallet", () => {
  it("settles concurrent payment IDs without nonce or allowance races", async () => {
    const config = loadConfig();
    expect(meterConfigured(config), "Run through the disposable integration runner").toBe(true);
    const abi = JSON.parse(readFileSync(fileURLToPath(new URL("../../../contracts/out-solc/UsageMeter.json", import.meta.url)), "utf8")).abi as Abi;
    const client = createPublicClient({ chain: { ...foundry, id: config.ARC_CHAIN_ID }, transport: http(config.ARC_RPC_URL) });
    const meter = config.USAGE_METER_ADDRESS as Address;
    const first = createFacilitator(config);
    const second = createFacilitator(config);
    const paymentIds = [randomUUID(), randomUUID()];
    const amounts = [1000n, 2000n];
    const spentBefore = await client.readContract({ address: meter, abi, functionName: "spent", args: [first.payer] }) as bigint;

    // Each request constructs its own client, just as gateway.settlePayment does.
    const results = await Promise.allSettled([
      first.settle(paymentIds[0]!, amounts[0]!, false),
      second.settle(paymentIds[1]!, amounts[1]!, false),
    ]);
    expect(results.map((result) => result.status === "fulfilled"
      ? "fulfilled"
      : String((result.reason as { shortMessage?: string }).shortMessage ?? result.reason)))
      .toEqual(["fulfilled", "fulfilled"]);
    for (const paymentId of paymentIds) {
      expect(await client.readContract({ address: meter, abi, functionName: "settled", args: [paymentIdToBytes32(paymentId)] })).toBe(true);
    }
    const spentAfter = await client.readContract({ address: meter, abi, functionName: "spent", args: [first.payer] }) as bigint;
    expect(spentAfter - spentBefore).toBe(3000n);
  });
});
