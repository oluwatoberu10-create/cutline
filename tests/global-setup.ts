/**
 * Rebuilds the `cutline_test` database from migrations before every run.
 * The development database is never touched.
 */
import { rmSync } from "node:fs";
import { Client } from "pg";

export const TEST_DB = "cutline_test";

export default async function setup() {
  const { start, isRunning, ensureDatabase, PG_PORT, PG_USER, PG_PASSWORD } = await import("../scripts/pg");
  if (!isRunning()) start();
  await ensureDatabase(TEST_DB);

  const url = `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${TEST_DB}`;
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await client.end();

  process.env.DATABASE_URL = url;
  const { runMigrations, closePool } = await import("../src/db/migrate");
  await runMigrations();
  await closePool();
  rmSync(".media-test", { recursive: true, force: true });
  rmSync(".scratch-test", { recursive: true, force: true });
}
