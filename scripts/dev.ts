/**
 * `npm run dev` (or `npm run preview` for a fast production build) — brings
 * the local Postgres cluster up (creating it on first
 * run), applies any pending migrations, then hands over to Next.js.
 *
 * If DATABASE_URL points somewhere else, the local cluster is left alone.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "./env";
import { start, isRunning, ensureDatabase, LOCAL_DATABASE_URL } from "./pg";

/** Local only: create the two required secrets once, in .env.local (git-ignored). */
function ensureLocalSecrets() {
  const add: string[] = [];
  if (!process.env.CUTLINE_ENCRYPTION_KEY) add.push(`CUTLINE_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
  if (!process.env.CUTLINE_SIGNING_SECRET) add.push(`CUTLINE_SIGNING_SECRET=${randomBytes(48).toString("base64url")}`);
  if (!add.length) return;
  const prefix = existsSync(".env.local") ? "\n" : "";
  appendFileSync(".env.local", [`${prefix}# Generated for local development by scripts/dev.ts`, ...add, ""].join("\n"));
  for (const line of add) { const [k, v] = line.split(/=(.*)/s); process.env[k] = v; }
  console.log("[dev] generated local secrets in .env.local");
}

async function main() {
  loadDotEnv();
  if (!process.env.VERCEL && !process.env.CI && process.env.NODE_ENV !== "production") ensureLocalSecrets();
  const usingLocal = !process.env.DATABASE_URL || process.env.DATABASE_URL === LOCAL_DATABASE_URL;

  if (usingLocal) {
    process.env.DATABASE_URL = LOCAL_DATABASE_URL;
    if (!isRunning()) start();
    else console.log("[pg] already running");
    await ensureDatabase();
  } else {
    console.log("[db] using DATABASE_URL from the environment");
  }

  // Imported only now, after DATABASE_URL is settled: the pool is built at import time.
  const { runMigrations, closePool } = await import("../src/db/migrate");
  await runMigrations();
  await closePool();
  console.log("[db] migrations up to date");

  const bin = process.platform === "win32" ? "node_modules\\.bin\\next.cmd" : "node_modules/.bin/next";
  const opts = { stdio: "inherit" as const, env: process.env, shell: process.platform === "win32" };
  const prod = process.argv.includes("--prod");
  const args = process.argv.slice(2).filter((a) => a !== "--prod" && a !== "--no-worker");

  // --prod (`npm run preview`): optimised build + `next start`. Much faster
  // page loads than `next dev`, which compiles each page on first visit.
  if (prod) {
    const build = spawnSync(bin, ["build"], opts);
    if (build.status !== 0) process.exit(build.status ?? 1);
  }
  const next = spawn(bin, [prod ? "start" : "dev", ...args], opts);
  // The worker runs FFmpeg, transcription and uploads; start one alongside the web app unless told not to.
  const worker = process.argv.includes("--no-worker") ? null
    : spawn(join("node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx"), ["--conditions=react-server", "scripts/worker.ts"], opts);
  next.on("exit", (code) => { worker?.kill(); process.exit(code ?? 0); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { next.kill(signal); worker?.kill(signal); });
}

main().catch((err) => {
  console.error("[dev]", err);
  process.exit(1);
});
