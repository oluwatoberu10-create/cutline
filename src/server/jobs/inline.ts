import "server-only";
import { after } from "next/server";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { log } from "../logger";

/**
 * Serverless job processing (Vercel). There is no long-running worker there,
 * so after a request that queued work — or a page view while work is pending —
 * the same function keeps running (`after`) and drains the queue within a time
 * budget. Jobs keep their normal leases, so anything cut off by the platform's
 * time limit is reclaimed later.
 *
 * Outside Vercel this does nothing: the dedicated worker process does the work.
 */
let draining = false;

export function kickInline(): void {
  if (!process.env.VERCEL || draining) return;
  try {
    after(() => runInline());
  } catch {
    // Not inside a request scope (e.g. already in an after callback): the running drain picks the job up.
  }
}

export async function runInline(budgetMs = 240_000): Promise<number> {
  if (draining) return 0;
  draining = true;
  try {
    const { drain } = await import("./worker");
    return await drain({ workerId: `inline-${process.pid}`, deadline: Date.now() + budgetMs });
  } catch (err) {
    log.error("inline drain failed", { err });
    return 0;
  } finally {
    draining = false;
  }
}

/** Cheap check used by pages: start a drain only if something is runnable now. */
export async function kickIfPending(): Promise<void> {
  if (!process.env.VERCEL) return;
  const [row] = await db.select({ n: sql<number>`count(*)` }).from(jobs)
    .where(or(and(eq(jobs.status, "queued"), lte(jobs.runAt, new Date())), and(eq(jobs.status, "running"), lte(jobs.lockedUntil, new Date()))));
  if (Number(row?.n ?? 0) > 0) kickInline();
}
