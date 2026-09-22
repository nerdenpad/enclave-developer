import type { Database } from "@enclave/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { vi } from "vitest";

/** Boundary double: SQL predicates remain real Drizzle expressions. */
export function testDb() {
  const rows = vi.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
  const returning = vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
  const execute = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const onConflictDoNothing = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const onConflictDoUpdate = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoNothing, onConflictDoUpdate, returning });
  const mutation = {
    returning,
    then: (resolve: (value: void) => unknown, reject: (reason: unknown) => unknown) => execute().then(resolve, reject),
  };
  const writeWhere = vi.fn().mockReturnValue(mutation);
  const set = vi.fn().mockReturnValue({ where: writeWhere });
  const query = {
    from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: rows,
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => rows().then(resolve, reject),
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  query.orderBy.mockReturnValue(query);
  const operations = {
    select: vi.fn().mockReturnValue(query),
    insert: vi.fn().mockReturnValue({ values }),
    update: vi.fn().mockReturnValue({ set }),
    delete: vi.fn().mockReturnValue({ where: writeWhere }),
    transaction: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
  };
  // REASON: tests implement only the Drizzle query boundary used by the worker.
  const db = operations as unknown as Database;
  operations.transaction.mockImplementation(async (run: (tx: Database) => Promise<unknown>) => run(db));
  return { db, ...operations, sqlExecute: operations.execute, query, rows, returning, execute, values, set, writeWhere, onConflictDoNothing, onConflictDoUpdate };
}

export function sqlQuery(condition: SQL) {
  return new PgDialect().sqlToQuery(condition);
}
