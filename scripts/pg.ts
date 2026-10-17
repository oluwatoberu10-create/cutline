/**
 * Local Postgres cluster management.
 *
 * Uses the real Postgres binaries shipped by @embedded-postgres and drives them
 * with `pg_ctl`, so the server is a normal background daemon that outlives the
 * script that started it. The app then talks to it over TCP exactly the way it
 * will talk to Neon/Supabase/RDS in production — one driver, one code path.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

export const PG_PORT = Number(process.env.CUTLINE_PG_PORT ?? 54333);
export const PG_USER = "cutline";
export const PG_PASSWORD = "cutline";
export const PG_DATABASE = "cutline";
export const LOCAL_DATABASE_URL =
  `postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`;

const ROOT = resolve(process.cwd());
const DATA_DIR = join(ROOT, ".pgdata");
const LOG_FILE = join(ROOT, ".pgdata", "server.log");
const PWFILE = join(ROOT, ".pgdata.pw");

/**
 * The platform packages expose only `./dist/index.js`, so the binaries cannot be
 * located with require.resolve — we walk to them directly instead.
 */
function binDir(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const platform =
    process.platform === "win32" ? "windows"
    : process.platform === "darwin" ? "darwin"
    : "linux";

  const dir = join(ROOT, "node_modules", "@embedded-postgres", `${platform}-${arch}`, "native", "bin");
  if (!existsSync(dir)) {
    throw new Error(
      `Postgres binaries not found at ${dir}.\n` +
      `Run: npm install @embedded-postgres/${platform}-${arch}`,
    );
  }
  return dir;
}

function bin(name: string): string {
  return join(binDir(), process.platform === "win32" ? `${name}.exe` : name);
}

function run(
  cmd: string,
  args: string[],
  opts: { quiet?: boolean; detach?: boolean } = {},
) {
  // `pg_ctl start` hands its stdio to the postgres daemon it spawns. If we
  // captured those pipes, spawnSync would block until the *server* exits rather
  // than until pg_ctl returns — so that one call runs with stdio ignored.
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: opts.detach ? "ignore" : "pipe",
    env: { ...process.env, PGPASSWORD: PG_PASSWORD },
  });
  if (!opts.detach) {
    if (!opts.quiet && result.stdout?.trim()) console.log(result.stdout.trim());
    if (!opts.quiet && result.stderr?.trim()) console.error(result.stderr.trim());
  }
  return result;
}

export function isRunning(): boolean {
  if (!existsSync(DATA_DIR)) return false;
  const result = spawnSync(bin("pg_ctl"), ["status", "-D", DATA_DIR], { encoding: "utf8" });
  return result.status === 0;
}

function initialise() {
  console.log("[pg] initialising cluster…");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PWFILE, PG_PASSWORD, "utf8");

  const result = run(bin("initdb"), [
    "-D", DATA_DIR,
    "-U", PG_USER,
    "--pwfile", PWFILE,
    "-E", "UTF8",
    "--no-locale",
    "-A", "scram-sha-256",
  ]);

  rmSync(PWFILE, { force: true });

  if (result.status !== 0) {
    rmSync(DATA_DIR, { recursive: true, force: true });
    throw new Error("initdb failed");
  }
}

export function start(): void {
  if (!existsSync(join(DATA_DIR, "PG_VERSION"))) initialise();

  if (isRunning()) {
    console.log(`[pg] already running on port ${PG_PORT}`);
    return;
  }

  console.log(`[pg] starting on port ${PG_PORT}…`);
  const result = run(bin("pg_ctl"), [
    "start",
    "-D", DATA_DIR,
    "-l", LOG_FILE,
    "-w", // wait until it is accepting connections
    // Windows forks each backend and remaps the shared-memory segment at the
    // same address in the child. A large segment collides with ASLR-placed
    // DLLs and every connection then dies with "could not reserve shared
    // memory region ... error code 487". A small segment places reliably.
    "-o", [
      `-p ${PG_PORT}`,
      "-c listen_addresses=127.0.0.1",
      "-c shared_buffers=16MB",
      "-c max_connections=30",
      ...(process.platform === "win32" ? ["-c dynamic_shared_memory_type=windows"] : []),
      "-c max_wal_size=256MB",
    ].join(" "),
  ], { detach: true });

  if (result.status !== 0) throw new Error(`pg_ctl start failed — see ${LOG_FILE}`);
}

/**
 * Creates the application database if it is missing.
 *
 * The binaries package ships only initdb and pg_ctl, so there is no `createdb`
 * to shell out to — we connect to the always-present `postgres` database and
 * issue the DDL ourselves.
 */
export async function ensureDatabase(name: string = PG_DATABASE): Promise<void> {
  const { Client } = await import("pg");
  const client = new Client({
    host: "127.0.0.1", port: PG_PORT, user: PG_USER, password: PG_PASSWORD, database: "postgres",
  });

  await client.connect();
  try {
    const existing = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (existing.rowCount === 0) {
      if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`invalid database name ${name}`);
      // Identifier cannot be parameterised; validated just above.
      await client.query(`create database "${name}"`);
      console.log(`[pg] created database "${name}"`);
    }
  } finally {
    await client.end();
  }
  console.log(`[pg] ready → ${LOCAL_DATABASE_URL}`);
}

export function stop(): void {
  if (!isRunning()) {
    console.log("[pg] not running");
    return;
  }
  run(bin("pg_ctl"), ["stop", "-D", DATA_DIR, "-m", "fast", "-w"]);
  console.log("[pg] stopped");
}

export function status(): void {
  console.log(isRunning() ? `[pg] running on ${PG_PORT}` : "[pg] stopped");
}

/**
 * Ensures a DATABASE_URL exists for local commands that need one. On Vercel or
 * CI there is no local cluster, so a missing URL is a configuration error.
 */
export function ensureEnv(): string {
  if (!process.env.DATABASE_URL && (process.env.VERCEL || process.env.CI)) {
    throw new Error(
      "DATABASE_URL is not set. Add a Postgres database (e.g. Neon from the Vercel Marketplace) " +
      "and set DATABASE_URL in Project Settings → Environment Variables, then redeploy.",
    );
  }
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = LOCAL_DATABASE_URL;
  return process.env.DATABASE_URL;
}

async function cli() {
  const command = process.argv[2];
  try {
    if (command === "start") { start(); await ensureDatabase(); }
    else if (command === "stop") stop();
    else if (command === "status") status();
    else if (command === "destroy") {
      if (isRunning()) stop();
      rmSync(DATA_DIR, { recursive: true, force: true });
      console.log("[pg] data directory removed");
    } else {
      console.log("usage: tsx scripts/pg.ts <start|stop|status|destroy>");
      process.exit(1);
    }
  } catch (err) {
    console.error("[pg]", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

if (/[\\/]pg\.ts$/.test(process.argv[1] ?? "")) void cli();
