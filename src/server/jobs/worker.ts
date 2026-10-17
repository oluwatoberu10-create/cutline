import "server-only";
import { hostname } from "node:os";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { errorMessage, isPermanent, RetryLater } from "@/lib/errors";
import { log } from "../logger";
import { ProviderError } from "../providers/llm";
import { failStep, noteStepError, advance } from "../workflow/engine";
import { HANDLERS, scheduleTick } from "./handlers";
import { claim, complete, failOrRetry, heartbeat, jobLog, markCancelled, type Job } from "./queue";

/**
 * The background worker. Run it as its own process (`npm run worker`);
 * nothing long-running happens inside web requests.
 */

export async function processJob(job: Job): Promise<"succeeded" | "retry" | "failed" | "cancelled" | "deferred"> {
  const handler = HANDLERS[job.type];
  const controller = new AbortController();
  let timedOut = false;

  if (job.attempts > job.maxAttempts) {
    await failOrRetry(job, "Abandoned: the worker lease expired more times than the retry limit allows.", true);
    await afterFinalFailure(job, "Abandoned after repeated worker failures.");
    return "failed";
  }
  if (!handler) {
    await failOrRetry(job, `Unknown job type ${job.type}`, true);
    return "failed";
  }

  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, job.timeoutSeconds * 1000);
  // Heartbeat keeps the lease alive and is how a running job learns it was cancelled.
  const beat = setInterval(async () => {
    try { const { cancelRequested } = await heartbeat(job.id); if (cancelRequested) controller.abort(); } catch { /* next beat */ }
  }, 15_000);
  let lastProgress = 0;
  const progress = async (pct: number, note?: string) => {
    if (Math.abs(pct - lastProgress) < 1 && !note) return;
    lastProgress = pct;
    const { cancelRequested } = await heartbeat(job.id, pct, note);
    if (cancelRequested) controller.abort();
  };

  try {
    await jobLog(job, "info", `Started ${job.type} (attempt ${job.attempts} of ${job.maxAttempts})`);
    const result = await handler({ job, signal: controller.signal, progress });
    await complete(job.id, result ?? null);
    await jobLog(job, "info", `Completed ${job.type}`);
    return "succeeded";
  } catch (err) {
    const [fresh] = await db.select({ cancel: jobs.cancelRequested }).from(jobs).where(eq(jobs.id, job.id));
    if (fresh?.cancel && !timedOut) {
      await markCancelled(job.id);
      await jobLog(job, "warn", "Cancelled");
      return "cancelled";
    }
    if (err instanceof RetryLater) {
      // Not a failure: re-check later without consuming an attempt.
      await db.update(jobs).set({ status: "queued", attempts: Math.max(0, job.attempts - 1), lockedBy: null, lockedUntil: null, runAt: new Date(Date.now() + err.delaySeconds * 1000), progressNote: err.message }).where(eq(jobs.id, job.id));
      return "deferred";
    }
    const message = timedOut ? `Timed out after ${job.timeoutSeconds}s.` : errorMessage(err);
    const permanent = !timedOut && (isPermanent(err) || (err instanceof ProviderError && !err.retryable));
    const retry = await failOrRetry(job, message, permanent);
    await jobLog(job, retry ? "warn" : "error", retry ? `Attempt ${job.attempts} failed; will retry: ${message}` : `Failed: ${message}`);
    if (!retry) await afterFinalFailure(job, message);
    else if (job.stepRunId) await noteStepError(job.stepRunId, message);
    if (!(err instanceof ProviderError) && !isPermanent(err)) log.error("job failed", { jobId: job.id, type: job.type, err });
    return retry ? "retry" : "failed";
  } finally {
    clearTimeout(timer);
    clearInterval(beat);
  }
}

async function afterFinalFailure(job: Job, message: string) {
  if (job.type === "workflow.step" && job.stepRunId && job.runId) {
    await failStep(job.stepRunId, message);
    await advance(job.runId);
  }
}

/** Processes jobs until the queue is empty (tests and one-shot runs). */
export async function drain(opts: { workerId?: string; maxJobs?: number; until?: () => Promise<boolean>; deadline?: number } = {}): Promise<number> {
  const id = opts.workerId ?? `drain-${process.pid}`;
  let n = 0;
  while (n < (opts.maxJobs ?? 1000) && (!opts.deadline || Date.now() < opts.deadline)) {
    const job = await claim(id);
    if (!job) break;
    await processJob(job);
    n++;
    if (opts.until && await opts.until()) break;
  }
  return n;
}

export async function runWorker(opts: { concurrency?: number; pollMs?: number } = {}) {
  const concurrency = opts.concurrency ?? Number(process.env.WORKER_CONCURRENCY ?? 2);
  const pollMs = opts.pollMs ?? 1500;
  const base = `${hostname()}:${process.pid}`;
  let stopping = false;
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => { stopping = true; log.info("worker stopping after current jobs"); });

  const loop = async (slot: number) => {
    const id = `${base}:${slot}`;
    while (!stopping) {
      try {
        const job = await claim(id);
        if (!job) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
        log.info("job claimed", { jobId: job.id, type: job.type, attempt: job.attempts });
        const outcome = await processJob(job);
        log.info("job finished", { jobId: job.id, type: job.type, outcome });
      } catch (err) {
        log.error("worker loop error", { err });
        await new Promise((r) => setTimeout(r, pollMs * 2));
      }
    }
  };

  const tick = async () => { try { await scheduleTick(); } catch (err) { log.error("schedule tick failed", { err }); } };
  await tick();
  const ticker = setInterval(tick, 60_000);
  log.info("worker started", { concurrency });
  await Promise.all(Array.from({ length: concurrency }, (_, i) => loop(i)));
  clearInterval(ticker);
}
