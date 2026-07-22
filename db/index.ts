import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";
import * as schema from "./schema";

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url().startsWith("postgresql://"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DATABASE_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(15_000),
});

type Database = NodePgDatabase<typeof schema>;

type DatabaseSingleton = {
  pool?: Pool;
  db?: Database;
};

const globalDatabase = globalThis as typeof globalThis & {
  __hardwareDatabase?: DatabaseSingleton;
};

function environment() {
  const parsed = databaseEnvironmentSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Invalid database configuration: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function poolConfig(): PoolConfig {
  const env = environment();
  return {
    connectionString: env.DATABASE_URL,
    application_name: process.env.SERVICE_NAME ?? "hardware-web",
    max: env.DATABASE_POOL_MAX,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
    ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  };
}

function singleton(): DatabaseSingleton {
  globalDatabase.__hardwareDatabase ??= {};
  return globalDatabase.__hardwareDatabase;
}

export function getPool(): Pool {
  const state = singleton();
  state.pool ??= new Pool(poolConfig());
  return state.pool;
}

export function getDb(): Database {
  const state = singleton();
  state.db ??= drizzle(getPool(), { schema, casing: "snake_case" });
  return state.db;
}

export async function checkDatabase(): Promise<void> {
  await getPool().query("select 1");
}

export async function closeDatabase(): Promise<void> {
  const state = singleton();
  if (!state.pool) return;
  await state.pool.end();
  state.pool = undefined;
  state.db = undefined;
}

export { schema };
