import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema.js";

export function createDb(url: string) {
  const sql = postgres(url, { max: 10, idle_timeout: 20 });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type Database = ReturnType<typeof createDb>["db"];
