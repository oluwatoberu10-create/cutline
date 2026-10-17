import "server-only";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "@/db";
import { contentIdeas, mediaAssets, stepRuns, workflowRuns } from "@/db/schema";
import type { AgentConfig } from "@/lib/blueprint/schema";
import { conflict, notConfigured, notFound, validationError } from "@/lib/errors";
import { evaluate, type ConditionScope } from "@/lib/workflow/condition";
import { collectRefs, topoSort, validateWorkflow, type WorkflowDefinition } from "@/lib/workflow/definition";
import { nodeSpec } from "@/lib/workflow/nodes";
import { enqueue, requestCancel } from "../jobs/queue";
import { effectiveConfig } from "../services/agent-config";
import { auditWs } from "../services/audit";
import type { WorkspaceCtx } from "../tenancy";

/**
 * Workflow engine.
 *
 * A run snapshots the workflow definition AND the effective agent config at
 * start, so later blueprint or deployment changes never alter a run in
 * flight. Progress lives entirely in `workflow_runs` / `step_runs`:
 *
 *   advance   — under a row lock on the run, decides which pending steps are
 *               ready, evaluates their conditions, skips or dispatches them,
 *               and settles the run's status. Safe to call any number of times.
 *   step job  — executes one node (see executors.ts) and calls advance.
 *
 * A worker crash leaves the step "running" with an expired job lease; the job
 * is reclaimed and the (idempotent) executor runs again.
 */

export type Run = typeof workflowRuns.$inferSelect;
export type StepRun = typeof stepRuns.$inferSelect;
type Snapshot = { workflow: WorkflowDefinition; config: AgentConfig };

const TERMINAL_STEP = new Set(["succeeded", "skipped", "failed", "cancelled"]);

export async function startRun(ws: WorkspaceCtx, opts: { workflowKey: string; input: Record<string, string>; trigger?: string }) {
  const { config, deployment } = await effectiveConfig(ws);
  if (!deployment) throw notConfigured("No agent is deployed to this workspace yet. Deploy a blueprint first (Agency → Deploy).");
  if (deployment.status !== "active") throw notConfigured(`The agent for this workspace is ${deployment.status}. Activate it before running workflows.`);
  const wf = config.workflows.find((w) => w.key === opts.workflowKey);
  if (!wf) throw notFound("Unknown workflow.");
  const issues = validateWorkflow(wf).filter((i) => i.level === "error");
  if (issues.length) throw validationError(`The workflow is invalid: ${issues.map((i) => i.message).join(" ")}`);

  const input: Record<string, string> = {};
  for (const spec of wf.inputs) {
    const v = opts.input[spec.key]?.trim();
    if (!v) { if (spec.required) throw validationError(`${spec.label} is required.`); continue; }
    if (spec.kind === "media_asset") {
      const [a] = await db.select({ id: mediaAssets.id }).from(mediaAssets).where(and(eq(mediaAssets.id, v), eq(mediaAssets.workspaceId, ws.workspaceId), eq(mediaAssets.role, "source"))).limit(1);
      if (!a) throw validationError(`${spec.label}: recording not found in this workspace.`);
    }
    if (spec.kind === "content_idea") {
      const [i] = await db.select({ id: contentIdeas.id }).from(contentIdeas).where(and(eq(contentIdeas.id, v), eq(contentIdeas.workspaceId, ws.workspaceId))).limit(1);
      if (!i) throw validationError(`${spec.label}: idea not found in this workspace.`);
    }
    input[spec.key] = v.slice(0, 200);
  }

  return db.transaction(async (tx) => {
    const [run] = await tx.insert(workflowRuns).values({
      workspaceId: ws.workspaceId, deploymentId: deployment.id, workflowKey: wf.key, workflowName: wf.name,
      definition: { workflow: wf, config } satisfies Snapshot, trigger: opts.trigger ?? "manual", input, createdBy: ws.actorId,
    }).returning();
    await tx.insert(stepRuns).values(wf.nodes.map((n) => ({ workspaceId: ws.workspaceId, runId: run.id, nodeId: n.id, nodeType: n.type })));
    await enqueue({ type: "workflow.advance", workspaceId: ws.workspaceId, runId: run.id, payload: { runId: run.id } }, tx);
    await auditWs(ws, { action: "workflow.start", entityType: "workflow_run", entityId: run.id, summary: `Started "${wf.name}"` }, tx);
    return run;
  });
}

/** Resolves `{ $from }` references against run input and upstream outputs. */
export function resolveConfig(value: unknown, scope: ConditionScope): unknown {
  if (Array.isArray(value)) return value.map((v) => resolveConfig(v, scope));
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.$from === "string") {
      const [head, ...rest] = rec.$from.split(".");
      let cur: unknown = head === "input" ? scope.input : scope.steps;
      for (const p of rest) {
        if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
        cur = (cur as Record<string, unknown>)[p];
      }
      return cur;
    }
    return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, resolveConfig(v, scope)]));
  }
  return value;
}

function scopeFor(run: Run, steps: StepRun[]): ConditionScope {
  const snap = run.definition as Snapshot;
  return { config: snap.config, input: run.input, steps: Object.fromEntries(steps.map((s) => [s.nodeId, { output: s.output ?? undefined, status: s.status }])) };
}

export async function advance(runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).for("update");
    if (!run || ["succeeded", "failed", "cancelled"].includes(run.status)) return;
    const snap = run.definition as Snapshot;
    const wf = snap.workflow;
    const order = topoSort(wf.nodes) ?? wf.nodes.map((n) => n.id);
    const byId = new Map(wf.nodes.map((n) => [n.id, n]));
    let steps = await tx.select().from(stepRuns).where(eq(stepRuns.runId, runId));
    const stepOf = (id: string) => steps.find((s) => s.nodeId === id)!;

    if (run.status === "queued") await tx.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, runId));

    let changed = true;
    while (changed) {
      changed = false;
      for (const id of order) {
        const step = stepOf(id), node = byId.get(id)!;
        if (step.status !== "pending") continue;
        const deps = node.dependsOn.map(stepOf);
        if (deps.some((d) => d.status === "failed" || d.status === "cancelled")) continue;
        if (!deps.every((d) => d.status === "succeeded" || d.status === "skipped")) continue;

        const scope = scopeFor(run, steps);
        // A node consuming the output of a skipped step is skipped too.
        const upstreamSkipped = collectRefs(node.config).some((r) => { const m = /^steps\.([a-z0-9_]+)\./.exec(r); return m ? stepOf(m[1])?.status === "skipped" : false; });
        let skipReason: string | null = upstreamSkipped ? "An upstream step it depends on was skipped." : null;
        if (!skipReason && node.when && !evaluate(node.when, scope)) skipReason = "Its condition was not met.";
        if (skipReason) {
          await tx.update(stepRuns).set({ status: "skipped", finishedAt: new Date(), output: { skipped: skipReason } }).where(eq(stepRuns.id, step.id));
        } else {
          const spec = nodeSpec(node.type)!;
          const t = snap.config.policies.timeouts;
          const timeout = node.type.startsWith("render.") ? t.renderSeconds : node.type === "media.transcribe" ? t.transcriptionSeconds : node.type === "publish.upload" ? t.uploadSeconds : t.defaultSeconds;
          await tx.update(stepRuns).set({ status: "running", startedAt: new Date(), attempt: step.attempt + 1, error: null }).where(eq(stepRuns.id, step.id));
          await enqueue({
            type: "workflow.step", workspaceId: run.workspaceId, runId, stepRunId: step.id, payload: { runId, stepRunId: step.id },
            dedupeKey: `step:${step.id}`, timeoutSeconds: timeout, maxAttempts: spec.sideEffect ? Math.min(3, snap.config.policies.retry.maxAttempts) : snap.config.policies.retry.maxAttempts,
          }, tx);
        }
        steps = await tx.select().from(stepRuns).where(eq(stepRuns.runId, runId));
        changed = true;
      }
    }

    const failed = steps.find((s) => s.status === "failed");
    if (failed) {
      await tx.update(stepRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(stepRuns.runId, runId), eq(stepRuns.status, "pending")));
      await tx.update(workflowRuns).set({ status: "failed", finishedAt: new Date(), error: `Step "${failed.nodeId}" failed: ${failed.error ?? "unknown error"}` }).where(eq(workflowRuns.id, runId));
      return;
    }
    if (steps.every((s) => TERMINAL_STEP.has(s.status))) {
      await tx.update(workflowRuns).set({ status: "succeeded", finishedAt: new Date(), error: null }).where(eq(workflowRuns.id, runId));
      return;
    }
    const waiting = steps.some((s) => s.status === "waiting") && !steps.some((s) => s.status === "running");
    await tx.update(workflowRuns).set({ status: waiting ? "waiting" : "running" }).where(eq(workflowRuns.id, runId));
  });
}

export async function loadStepForExecution(runId: string, stepRunId: string) {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  const [step] = await db.select().from(stepRuns).where(and(eq(stepRuns.id, stepRunId), eq(stepRuns.runId, runId))).limit(1);
  if (!run || !step) throw notFound("Workflow step not found.");
  const steps = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId));
  const snap = run.definition as Snapshot;
  const node = snap.workflow.nodes.find((n) => n.id === step.nodeId)!;
  return { run, step, node, config: snap.config, resolved: resolveConfig(node.config, scopeFor(run, steps)) as Record<string, unknown> };
}

export async function completeStep(stepRunId: string, result: { status: "succeeded" | "waiting"; output?: Record<string, unknown> }, conn: DbOrTx = db) {
  await conn.update(stepRuns).set({
    status: result.status, output: result.output ?? null, ...(result.status === "succeeded" ? { finishedAt: new Date() } : {}), error: null,
  }).where(and(eq(stepRuns.id, stepRunId), inArray(stepRuns.status, ["running", "waiting"])));
}

export async function failStep(stepRunId: string, error: string, conn: DbOrTx = db) {
  await conn.update(stepRuns).set({ status: "failed", error: error.slice(0, 2000), finishedAt: new Date() }).where(and(eq(stepRuns.id, stepRunId), inArray(stepRuns.status, ["running", "waiting"])));
}

export async function noteStepError(stepRunId: string, error: string) {
  await db.update(stepRuns).set({ error: `Retrying after: ${error}`.slice(0, 2000) }).where(eq(stepRuns.id, stepRunId));
}

/** Called when a linked approval is decided. */
export async function resumeStep(ws: WorkspaceCtx, stepRunId: string, decision: "approved" | "rejected", note: string, tx: Tx) {
  const [step] = await tx.select().from(stepRuns).where(and(eq(stepRuns.id, stepRunId), eq(stepRuns.workspaceId, ws.workspaceId))).limit(1);
  if (!step || step.status !== "waiting") return;
  if (decision === "approved") await completeStep(step.id, { status: "succeeded", output: { ...(step.output as object ?? {}), decision: "approved" } }, tx);
  else await failStep(step.id, `Rejected by reviewer${note ? `: ${note}` : ""}`, tx);
  await enqueue({ type: "workflow.advance", workspaceId: ws.workspaceId, runId: step.runId, payload: { runId: step.runId } }, tx);
}

export async function cancelRun(ws: WorkspaceCtx, runId: string) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, ws.workspaceId))).for("update");
    if (!run) throw notFound("Run not found.");
    if (["succeeded", "failed", "cancelled"].includes(run.status)) throw conflict(`The run already ${run.status}.`);
    await tx.update(workflowRuns).set({ status: "cancelled", finishedAt: new Date(), error: "Cancelled by a user." }).where(eq(workflowRuns.id, runId));
    await tx.update(stepRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, ["pending", "running", "waiting"])));
    await requestCancel({ runId }, tx);
    const { cancelApprovalsForRun } = await import("../services/approvals");
    await cancelApprovalsForRun(runId, tx);
    await auditWs(ws, { action: "workflow.cancel", entityType: "workflow_run", entityId: runId, summary: `Cancelled "${run.workflowName}"` }, tx);
  });
}

/**
 * Retries a failed run from where it stopped: failed and cancelled steps go
 * back to pending; succeeded steps are kept (their side effects are not repeated).
 */
export async function retryRun(ws: WorkspaceCtx, runId: string) {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, ws.workspaceId))).for("update");
    if (!run) throw notFound("Run not found.");
    if (run.status !== "failed" && run.status !== "cancelled") throw conflict("Only failed or cancelled runs can be retried.");
    await tx.update(stepRuns).set({ status: "pending", error: null, startedAt: null, finishedAt: null }).where(and(eq(stepRuns.runId, runId), inArray(stepRuns.status, ["failed", "cancelled"])));
    await tx.update(workflowRuns).set({ status: "running", error: null, finishedAt: null }).where(eq(workflowRuns.id, runId));
    await enqueue({ type: "workflow.advance", workspaceId: ws.workspaceId, runId, payload: { runId } }, tx);
    await auditWs(ws, { action: "workflow.retry", entityType: "workflow_run", entityId: runId, summary: `Retried "${run.workflowName}"` }, tx);
  });
}

export async function listRuns(ws: WorkspaceCtx, limit = 50) {
  return db.select().from(workflowRuns).where(eq(workflowRuns.workspaceId, ws.workspaceId)).orderBy(desc(workflowRuns.createdAt)).limit(limit);
}

export async function getRun(ws: WorkspaceCtx, runId: string) {
  const [run] = await db.select().from(workflowRuns).where(and(eq(workflowRuns.id, runId), eq(workflowRuns.workspaceId, ws.workspaceId))).limit(1);
  if (!run) throw notFound("Run not found.");
  const steps = await db.select().from(stepRuns).where(eq(stepRuns.runId, runId)).orderBy(asc(stepRuns.startedAt));
  return { run, steps };
}

export async function runCounts(workspaceIds: string[]) {
  if (!workspaceIds.length) return {} as Record<string, number>;
  const rows = await db.select({ status: workflowRuns.status, n: sql<number>`count(*)` }).from(workflowRuns).where(inArray(workflowRuns.workspaceId, workspaceIds)).groupBy(workflowRuns.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}
