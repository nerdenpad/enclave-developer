import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "@enclave/db";
import type { DevCvm } from "@enclave/core";
import { EnclaveGateway } from "./gateway.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";

describe("public Arc receipt count", () => {
  it("restricts the SQL aggregate to confirmed Arc anchors and the configured verifier", async () => {
    let condition: SQL | undefined;
    const db = { select: vi.fn(() => ({ from: () => ({ where: async (where: SQL) => { condition = where; return [{ total: 3 }]; } }) })) } as unknown as Database;
    const config = loadConfig({ DATABASE_URL: "postgres://unused", ATTESTATION_VERIFIER_ADDRESS: `0x${"12".repeat(20)}` });
    const gateway = new EnclaveGateway(db, {} as DevCvm, config, createLogger("silent"), undefined);
    expect(await gateway.arcReceiptCount()).toEqual({ chainId: 5042, verifierAddress: config.ATTESTATION_VERIFIER_ADDRESS, confirmed: 3 });
    const query = new PgDialect().sqlToQuery(condition!);
    expect(query.sql).toContain('"receipts"."chain_id"');
    expect(query.sql).toContain('"receipts"."status"');
    expect(query.sql).toContain('lower("receipts"."verifier_address")');
    expect(query.sql).toContain('"receipts"."anchored_tx" ~');
    expect(query.params).toContain(5042);
    expect(query.params).toContain("anchored");
    expect(query.params).toContain(config.ATTESTATION_VERIFIER_ADDRESS);
  });
});
