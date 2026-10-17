/**
 * Applies the generated SQL migrations in ./drizzle.
 * Safe to run repeatedly — drizzle records which migrations have been applied.
 */
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, getPool } from "./index";

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}

export async function closePool(): Promise<void> {
  await getPool().end();
}
