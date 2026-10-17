import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { jobs, runLogs } from "@/db/schema";
import { redact } from "../logger";

/**
 * Durable job queue on Postgres.
 *
 * - enqueue: inserts a row; a `dedupeKey` collapses duplicate requests while
 *   an earlier copy is still queued or running (partial unique index).
 * - claim: `FOR UPDATE SKIP LOCKED` hands each job to exactly one worker and
 *   sets a lease. A crashed worker's lease expires and the job is reclaimed —
 *   handlers are written to be idempotent so that re-running is safe.
 * - Long-running work (FFmpeg, uploads) never runs inside an HTTP request.
 */

export type Job = typeof jobs.$inferSelect;

export type EnqueueOptions = {
  type: string;
  payload?: Record<string, unknown>;
  workspaceId?: string | null;
  dedupeKey?: string | null;
  maxAttempts?: number;
  timeoutSeconds?: number;
  runAt?: Date;
  runId?: string | null;
  stepRunId?: string | null;
  createdBy?: string | null;
};

export async function enqueue(opts: EnqueueOptions, conn: DbOrTx = db): Promise<Job> {
  if (process.env.VERCEL) (await import("./inline")).kickInline();
  const inserted = await conn.insert(jobs).values({
    type: opts.type, payload: opts.payload ?? {}, workspaceId: opts.workspaceId ?? null, dedupeKey: opts.dedupeKey ?? null,
    maxAttempts: opts.maxAttempts ?? 3, timeoutSeconds: opts.timeoutSeconds ?? 900, runAt: opts.runAt ?? new Date(),
    runId: opts.runId ?? null, stepRunId: opts.stepRunId ?? null, createdBy: opts.createdBy ?? null,
  }).onConflictDoNothing().returning();
  if (inserted[0]) return inserted[0];
  // A duplicate of active work: hand back the existing job instead of queuing another.
  const [existing] = await conn.select().from(jobs)
    .where(and(eq(jobs.dedupeKey, opts.dedupeKey!), inArray(jobs.status, ["queued", "running"]))).limit(1);
  if (!existing) throw new Error("Job enqueue conflicted but no active duplicate was found.");
  return existing;
}

/** Claims the next runnable job (or one whose worker lease expired). */
export async function claim(workerId: string): Promise<Job | null> {
  const res = await db.execute<Record<string, unknown>>(sql`
    update ${jobs} set
      status = 'running',
      attempts = ${jobs.attempts} + 1,
      locked_by = ${workerId},
      locked_until = now() + make_interval(secs => ${jobs.timeoutSeconds} + 60),
      started_at = coalesce(${jobs.startedAt}, now())
    where ${jobs.id} = (
      select id from ${jobs}
      where (status = 'queued' and run_at <= now())
         or (status = 'running' and locked_until < now())
      order by run_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = res.rows[0]?.id as string | undefined;
  if (!id) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return job ?? null;
}

/** Extends the lease while a long job is still making progress. */
export async function heartbeat(jobId: string, progress?: number, note?: string): Promise<{ cancelRequested: boolean }> {
  const [row] = await db.update(jobs).set({
    lockedUntil: sql`now() + make_interval(secs => ${jobs.timeoutSeconds} + 60)`,
    ...(progress !== undefined ? { progress: Math.max(0, Math.min(100, Math.round(progress))) } : {}),
    ...(note !== undefined ? { progressNote: note.slice(0, 300) } : {}),
  }).where(eq(jobs.id, jobId)).returning({ cancelRequested: jobs.cancelRequested });
  return { cancelRequested: row?.cancelRequested ?? false };
}

export async function complete(jobId: string, result: unknown): Promise<void> {
  await db.update(jobs).set({ status: "succeeded", result: result ?? null, progress: 100, finishedAt: new Date(), lockedUntil: null, error: null }).where(eq(jobs.id, jobId));
}

/** Returns true if the job will be retried. */
export async function failOrRetry(job: Job, error: string, permanent: boolean, backoffSeconds = 30): Promise<boolean> {
  const retry = !permanent && job.attempts < job.maxAttempts;
  if (retry) {
    const delay = backoffSeconds * 2 ** Math.max(0, job.attempts - 1);
    await db.update(jobs).set({ status: "queued", error: error.slice(0, 2000), lockedBy: null, lockedUntil: null, runAt: new Date(Date.now() + delay * 1000) }).where(eq(jobs.id, job.id));
  } else {
    await db.update(jobs).set({ status: "failed", error: error.slice(0, 2000), finishedAt: new Date(), lockedUntil: null }).where(eq(jobs.id, job.id));
  }
  return retry;
}

export async function markCancelled(jobId: string, reason = "Cancelled"): Promise<void> {
  await db.update(jobs).set({ status: "cancelled", error: reason, finishedAt: new Date(), lockedUntil: null }).where(eq(jobs.id, jobId));
}

/**
 * Requests cancellation: queued jobs stop immediately; running jobs see
 * `cancelRequested` on their next heartbeat and abort their subprocess.
 */
export async function requestCancel(where: { jobId?: string; runId?: string }, conn: DbOrTx = db): Promise<void> {
  const cond = where.jobId ? eq(jobs.id, where.jobId) : eq(jobs.runId, where.runId!);
  await conn.update(jobs).set({ status: "cancelled", finishedAt: new Date(), error: "Cancelled" }).where(and(cond, eq(jobs.status, "queued")));
  await conn.update(jobs).set({ cancelRequested: true }).where(and(cond, eq(jobs.status, "running")));
}

/** Puts a failed or cancelled job back in the queue with a fresh attempt budget. */
export async function retryJob(jobId: string, conn: DbOrTx = db): Promise<void> {
  await conn.update(jobs).set({ status: "queued", attempts: 0, error: null, runAt: new Date(), cancelRequested: false, lockedBy: null, lockedUntil: null, finishedAt: null, progress: 0 })
    .where(and(eq(jobs.id, jobId), inArray(jobs.status, ["failed", "cancelled"])));
}

export async function jobLog(job: Pick<Job, "id" | "workspaceId" | "runId">, level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): Promise<void> {
  await db.insert(runLogs).values({ jobId: job.id, workspaceId: job.workspaceId, runId: job.runId, level, message: message.slice(0, 2000), data: data ? (redact(data) as object) : null });
}

export async function latestJobFor(workspaceId: string, type: string, key: string) {
  const [row] = await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, type), eq(jobs.dedupeKey, key))).orderBy(desc(jobs.createdAt)).limit(1);
  return row ?? null;
}
