import { sql } from "drizzle-orm";
import { db } from "@/db";
import { versions } from "@/server/media/ffmpeg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness + dependency check for load balancers and deployment verification. Reveals no configuration values. */
export async function GET() {
  const checks: Record<string, boolean> = {};
  try { await db.execute(sql`select 1`); checks.database = true; } catch { checks.database = false; }
  const ff = await versions();
  checks.ffmpeg = Boolean(ff.ffmpeg);
  checks.ffprobe = Boolean(ff.ffprobe);
  checks.encryptionKey = Boolean(process.env.CUTLINE_ENCRYPTION_KEY);
  checks.signingSecret = Boolean(process.env.CUTLINE_SIGNING_SECRET);
  const [w] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from jobs where status = 'running' and locked_until > now()`).catch(() => ({ rows: [{ n: -1 }] }))).rows;
  const ok = Object.values(checks).every(Boolean);
  return Response.json({ ok, checks, runningJobs: w?.n ?? null }, { status: ok ? 200 : 503 });
}
