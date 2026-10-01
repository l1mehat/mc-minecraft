import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
  __arenaNextJsDb?: NodePgDatabase;
};

function getPool(): Pool {
  if (globalForDb.__arenaNextJsPostgresqlPool) {
    return globalForDb.__arenaNextJsPostgresqlPool;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: databaseUrl });
  globalForDb.__arenaNextJsPostgresqlPool = pool;
  return pool;
}

function getDb(): NodePgDatabase {
  if (!globalForDb.__arenaNextJsDb) {
    globalForDb.__arenaNextJsDb = drizzle(getPool());
  }
  return globalForDb.__arenaNextJsDb;
}

function lazy<T extends object>(getter: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      const real = getter();
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

export const pool = lazy(getPool);
export const db = lazy(getDb);