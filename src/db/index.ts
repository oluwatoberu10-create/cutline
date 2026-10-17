/**
 * Database connection — PostgreSQL via node-postgres.
 *
 * One driver for every environment. Locally, `npm run dev` boots a real
 * Postgres 18 cluster (scripts/pg.ts) and points DATABASE_URL at it; in
 * production the same code connects to Supabase, Neon, RDS or anything else
 * that speaks Postgres. No dialect differences, no dev-only SQL path.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export const DEFAULT_LOCAL_URL = "postgresql://cutline:cutline@127.0.0.1:54333/cutline";

function connectionString(): string {
  const url = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL;
  // `next build` imports server modules to collect page data; the pool never
  // connects there (pg connects lazily on first query), so only enforce this
  // when the app is actually running.
  const building = process.env.NEXT_PHASE === "phase-production-build";
  if (!process.env.DATABASE_URL && process.env.NODE_ENV === "production" && !building) {
    throw new Error("DATABASE_URL must be set in production.");
  }
  return url;
}

function isLocal(url: string): boolean {
  return url.includes("127.0.0.1") || url.includes("localhost");
}

/**
 * True on Vercel, AWS Lambda and similar. Each concurrent request can get its
 * own instance of this module, so the pool size is per-instance, not global.
 */
function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

/**
 * Drops `sslmode` from the URL.
 *
 * TLS is configured explicitly below, so the parameter is redundant — and
 * pg-connection-string logs a warning at *error* level for `sslmode=require`
 * on every cold start, which on serverless means real errors get buried under
 * a warning about a future major version.
 */
function stripSslMode(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("sslmode");
    return parsed.toString();
  } catch {
    // Not a URL we can parse — hand it to pg untouched rather than mangling it.
    return url;
  }
}

function createPool(): Pool {
  const raw = connectionString();
  const url = isLocal(raw) ? raw : stripSslMode(raw);
  const serverless = isServerless();

  return new Pool({
    connectionString: url,
    /**
     * On a long-lived server one pool of ten is right. On serverless it is a
     * trap: fifty warm instances would each hold ten connections and exhaust
     * Postgres. Keep it at one per instance and put a real pooler (Neon's
     * `-pooler` host, Supabase's port 6543, PgBouncer) in front instead.
     */
    max: Number(process.env.DATABASE_POOL_MAX ?? (serverless ? 1 : 10)),
    // Release the connection quickly when an instance goes idle between requests.
    idleTimeoutMillis: serverless ? 10_000 : 30_000,
    connectionTimeoutMillis: 10_000,
    // Hosted Postgres providers terminate non-TLS connections. Most present a
    // chain Node will not verify out of the box, hence the relaxed check; set
    // DATABASE_SSL_STRICT=true once you have confirmed your provider's CA.
    ssl: isLocal(url)
      ? undefined
      : { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === "true" },
  });
}

// Cached on globalThis so Next's dev hot-reload reuses one pool instead of
// leaking a new one on every edit.
const globalForDb = globalThis as unknown as { __cutlinePool?: Pool };
const pool = (globalForDb.__cutlinePool ??= createPool());

export const db = drizzle(pool, { schema, casing: "snake_case" });
export type Db = typeof db;

/** Async accessor kept so call sites read the same in server components. */
export async function getDb(): Promise<Db> {
  return db;
}

export function getPool(): Pool {
  return pool;
}

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Either the pool-backed client or an open transaction. */
export type DbOrTx = Db | Tx;

/**
 * Runs `fn` inside a transaction. Multi-step writes — a submission plus its
 * status change plus its notifications — use this so a failure halfway through
 * leaves nothing behind.
 */
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

export { schema };
