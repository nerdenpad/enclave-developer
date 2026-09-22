import { config as loadDotenv } from "dotenv";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { createFacilitator, meterConfigured } from "./chain.js";

loadDotenv({ path: new URL("../../../.env", import.meta.url) });
loadDotenv();

const cfg = (() => {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
})();

const liveMeter = Boolean(cfg && meterConfigured(cfg));

describe.skipIf(!liveMeter)("UsageMeter chain (day 11)", () => {
  it("reverts a second settle of the same paymentId (replay)", async () => {
    const facilitator = createFacilitator(cfg!);
    const paymentId = crypto.randomUUID();
    const tx = await facilitator.settle(paymentId, 1000n, false);
    expect(tx).toMatch(/^0x/);
    await expect(facilitator.settle(paymentId, 1000n, false)).rejects.toThrow();
  });

  it("settles the confidential stub path without a second USDC transferFrom", async () => {
    const facilitator = createFacilitator(cfg!);
    const tx = await facilitator.settle(crypto.randomUUID(), 1000n, true);
    expect(tx).toMatch(/^0x/);
  });
});
