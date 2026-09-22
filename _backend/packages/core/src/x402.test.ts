import { describe, expect, it } from "vitest";
import { paymentRequiredBody, usdcToUnits } from "./x402.js";

describe("x402", () => {
  it("puts paymentId in extra so the client can settle then retry", () => {
    const body = paymentRequiredBody({
      network: "arc-31337",
      amountUnits: usdcToUnits(0.1),
      payTo: "0x0000000000000000000000000000000000000002",
      asset: "0x0000000000000000000000000000000000000003",
      paymentId: "11111111-1111-1111-1111-111111111111",
    });
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]?.extra.paymentId).toBe("11111111-1111-1111-1111-111111111111");
    expect(body.accepts[0]?.maxAmountRequired).toBe("100000");
  });
});
