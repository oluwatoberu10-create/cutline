import "server-only";
import { sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { auditLogs, rateLimits, usageCounters } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { redact } from "../logger";
import type { WorkspaceCtx } from "../tenancy";

export type AuditEntry = {
  orgId: string | null;
  workspaceId?: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
};

/** Records a significant action. Pass the transaction so the row commits with the change. */
export async function audit(entry: AuditEntry, conn: DbOrTx = db): Promise<void> {
  await conn.insert(auditLogs).values({
    orgId: entry.orgId, workspaceId: entry.workspaceId ?? null, actorId: entry.actorId, action: entry.action,
    entityType: entry.entityType, entityId: entry.entityId ?? null, summary: entry.summary,
    metadata: redact(entry.metadata ?? {}) as Record<string, unknown>, ip: entry.ip ?? null,
  });
}

export function auditWs(ws: WorkspaceCtx, e: Omit<AuditEntry, "orgId" | "workspaceId" | "actorId">, conn: DbOrTx = db) {
  return audit({ ...e, orgId: ws.orgId, workspaceId: ws.workspaceId, actorId: ws.actorId }, conn);
}

/* ── rate limiting (fixed window, Postgres-backed so it holds across instances) ── */

export async function hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const result = await db.execute<{ count: number }>(sql`
    insert into ${rateLimits} (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when ${rateLimits.windowStart} < now() - make_interval(secs => ${windowSeconds}) then 1 else ${rateLimits.count} + 1 end,
      window_start = case when ${rateLimits.windowStart} < now() - make_interval(secs => ${windowSeconds}) then now() else ${rateLimits.windowStart} end
    returning count`);
  return Number(result.rows[0]?.count ?? 1) <= limit;
}

export async function enforceRate(key: string, limit: number, windowSeconds: number, message?: string): Promise<void> {
  if (!(await hit(key, limit, windowSeconds))) throw new AppError("RATE_LIMITED", message ?? "Too many requests. Please wait a moment and try again.");
}

/* ── usage limits ─────────────────────────────────────────────────────── */

export type UsageMetric = "render_minutes" | "transcription_minutes" | "llm_calls";

const period = () => new Date().toISOString().slice(0, 7);

export async function usageFor(workspaceId: string): Promise<Record<UsageMetric, number>> {
  const rows = await db.select().from(usageCounters).where(sql`${usageCounters.workspaceId} = ${workspaceId} and ${usageCounters.period} = ${period()}`);
  const out: Record<UsageMetric, number> = { render_minutes: 0, transcription_minutes: 0, llm_calls: 0 };
  for (const r of rows) out[r.metric as UsageMetric] = r.value;
  return out;
}

/** Throws PLAN_LIMIT_REACHED if adding `amount` would exceed the workspace's monthly limit. */
export async function checkUsage(ws: WorkspaceCtx, metric: UsageMetric, amount: number): Promise<void> {
  const limit = { render_minutes: ws.settings.limits.monthlyRenderMinutes, transcription_minutes: ws.settings.limits.monthlyTranscriptionMinutes, llm_calls: ws.settings.limits.monthlyLlmCalls }[metric];
  const used = (await usageFor(ws.workspaceId))[metric];
  if (used + amount > limit) {
    throw new AppError("PLAN_LIMIT_REACHED", `This workspace has used ${Math.round(used)} of its ${limit} monthly ${metric.replace("_", " ")}. Raise the limit in workspace settings to continue.`);
  }
}

export async function recordUsage(workspaceId: string, metric: UsageMetric, amount: number): Promise<void> {
  await db.insert(usageCounters).values({ workspaceId, period: period(), metric, value: amount })
    .onConflictDoUpdate({ target: [usageCounters.workspaceId, usageCounters.period, usageCounters.metric], set: { value: sql`${usageCounters.value} + ${amount}` } });
}
