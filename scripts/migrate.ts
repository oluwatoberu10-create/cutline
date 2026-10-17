/** Applies pending migrations to DATABASE_URL (or the local cluster). Safe in production. */
import { loadDotEnv } from "./env";

async function main() {
  loadDotEnv();
  const { ensureEnv } = await import("./pg");
  ensureEnv();
  const { runMigrations, closePool } = await import("../src/db/migrate");
  await runMigrations();
  await closePool();
  console.log("[db] migrations applied");
}

main().catch((e) => { console.error("[migrate]", e instanceof Error && !("cause" in e && e.cause) ? e.message : e); process.exit(1); });
