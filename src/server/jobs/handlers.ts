import "server-only";
import { rm } from "node:fs/promises";
import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { agentDeployments, mediaAssets, renderJobs, workspaces } from "@/db/schema";
import { PermanentError } from "@/lib/errors";
import { env } from "../env";
import { analyzeChannel, syncChannel } from "../services/channel";
import { proposeEdit, transcribeAsset } from "../services/editing";
import { generateIdeas } from "../services/ideas";
import { getAsset, ingestAsset, purgeAssetFiles } from "../services/media";
import { runUpload, trackPublishing } from "../services/publishing";
import { executeRender } from "../services/render";
import { driver } from "../storage";
import { systemWorkspace, type WorkspaceCtx } from "../tenancy";
import { advance, completeStep, loadStepForExecution } from "../workflow/engine";
import { EXECUTORS } from "../workflow/executors";
import { enqueue, type Job } from "./queue";

export type HandlerCtx = { job: Job; signal: AbortSignal; progress: (p: number, note?: string) => Promise<void> };
type Handler = (ctx: HandlerCtx) => Promise<unknown>;

const p = (job: Job) => job.payload as Record<string, string>;

async function ws(job: Job): Promise<WorkspaceCtx> {
  if (!job.workspaceId) throw new PermanentError("Job has no workspace.");
  const w = await systemWorkspace(job.workspaceId);
  if (w.status === "archived" && !["workspace.purge", "media.purge_files"].includes(job.type)) throw new PermanentError("The workspace is archived.");
  return w;
}

export const HANDLERS: Record<string, Handler> = {
  "media.ingest": async ({ job, signal, progress }) => {
    const w = await ws(job);
    const r = await ingestAsset(w, p(job).assetId, { jobId: job.id, signal, progress });
    if (!r.rejected) await triggerEvent(w, "media.ready", { assetId: p(job).assetId });
    return r;
  },
  "media.purge_files": async ({ job }) => {
    const [a] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, p(job).assetId), eq(mediaAssets.workspaceId, job.workspaceId!))).limit(1);
    if (a) await purgeAssetFiles(a);
    return { purged: Boolean(a) };
  },
  "media.transcribe": async ({ job, signal, progress }) => transcribeAsset(await ws(job), p(job).assetId, { jobId: job.id, signal, progress }),
  "edit.propose": async ({ job }) => proposeEdit(await ws(job), { assetId: p(job).assetId, ideaId: p(job).ideaId || null, useLlm: p(job).useLlm !== "false", sourceKey: `job:${job.id}` }),
  "render.execute": async ({ job, signal, progress }) => executeRender(await ws(job), p(job).renderJobId, { jobId: job.id, signal, progress }),
  "channel.sync": async ({ job }) => syncChannel(await ws(job), { maxVideos: Number(p(job).maxVideos ?? 200) }),
  "channel.analyze": async ({ job }) => analyzeChannel(await ws(job), { useLlm: p(job).useLlm !== "false" }),
  "ideas.generate": async ({ job }) => generateIdeas(await ws(job), { count: p(job).count ? Number(p(job).count) : undefined, focus: p(job).focus, batchKey: job.id }),

  "publish.upload": async ({ job, signal, progress }) => {
    const w = await ws(job);
    const r = await runUpload(w, p(job).publishingJobId, { signal, progress });
    await enqueue({ type: "publish.track", workspaceId: w.workspaceId, payload: { publishingJobId: p(job).publishingJobId }, dedupeKey: `track:${p(job).publishingJobId}`, runAt: new Date(Date.now() + 30_000), maxAttempts: 200 });
    return r;
  },
  "publish.track": async ({ job }) => {
    const w = await ws(job);
    const r = await trackPublishing(w, p(job).publishingJobId);
    if (!r.done && job.attempts < job.maxAttempts) {
      const { RetryLater } = await import("@/lib/errors");
      throw new RetryLater(60, "YouTube is still processing the video.");
    }
    return r;
  },

  "workflow.advance": async ({ job }) => { await advance(p(job).runId); return { advanced: true }; },

  "workflow.step": async ({ job, signal, progress }) => {
    const { run, step, node, config, resolved } = await loadStepForExecution(p(job).runId, p(job).stepRunId);
    if (run.status === "cancelled" || step.status === "cancelled") return { skipped: "cancelled" };
    if (step.status === "succeeded" || step.status === "skipped") return { skipped: "already done" };
    const executor = EXECUTORS[node.type];
    if (!executor) throw new PermanentError(`No executor for node type ${node.type}.`);
    const w = await ws(job);
    const res = await executor({ ws: w, run, step, config, params: resolved, jobId: job.id, signal, progress });
    await completeStep(step.id, res);
    await enqueue({ type: "workflow.advance", workspaceId: run.workspaceId, runId: run.id, payload: { runId: run.id } });
    return res;
  },

  "workflow.scheduled": async ({ job }) => {
    const w = await ws(job);
    const { startRun } = await import("../workflow/engine");
    const run = await startRun(w, { workflowKey: p(job).workflowKey, input: JSON.parse(p(job).input ?? "{}"), trigger: p(job).trigger ?? "schedule" });
    return { runId: run.id };
  },

  /** Removes every stored file of a workspace, then the workspace row (rows cascade). */
  "workspace.purge": async ({ job }) => {
    const id = p(job).workspaceId;
    const assets = await db.select().from(mediaAssets).where(eq(mediaAssets.workspaceId, id));
    const byId = new Map(assets.map((a) => [a.id, a]));
    const renders = await db.select({ captionsKey: renderJobs.captionsKey, outputAssetId: renderJobs.outputAssetId }).from(renderJobs).where(eq(renderJobs.workspaceId, id));
    for (const r of renders) {
      const owner = r.outputAssetId ? byId.get(r.outputAssetId) : undefined;
      if (r.captionsKey && owner) await (await driver(owner.storageDriver)).delete(r.captionsKey).catch(() => undefined);
    }
    for (const a of assets) await purgeAssetFiles(a);
    await rm(`${env.storage().localDir}/ws/${id}`, { recursive: true, force: true });
    await db.delete(workspaces).where(eq(workspaces.id, id));
    return { assets: assets.length };
  },

  /** Applies each workspace's retention settings. */
  "retention.sweep": async () => {
    const all = await db.select().from(workspaces);
    let removed = 0;
    for (const w of all) {
      const s = (await systemWorkspace(w.id)).settings.retention;
      const rules: { role: "render" | "source"; days: number }[] = [{ role: "render", days: s.renderDays }, { role: "source", days: s.sourceDays }];
      for (const r of rules) {
        if (!r.days) continue;
        const old = await db.select().from(mediaAssets).where(and(eq(mediaAssets.workspaceId, w.id), eq(mediaAssets.role, r.role), isNull(mediaAssets.deletedAt), lt(mediaAssets.createdAt, new Date(Date.now() - r.days * 864e5))));
        for (const a of old) {
          await purgeAssetFiles(a);
          await db.update(mediaAssets).set({ deletedAt: new Date(), status: "deleted" }).where(eq(mediaAssets.id, a.id));
          removed++;
        }
      }
    }
    return { removed };
  },
};

/** Starts any workflows of the workspace's active agent that listen for this event. */
export async function triggerEvent(w: WorkspaceCtx, event: "media.ready", input: { assetId: string }) {
  const asset = await getAsset(w, input.assetId);
  if (asset.role !== "source") return;
  const [d] = await db.select().from(agentDeployments).where(and(eq(agentDeployments.workspaceId, w.workspaceId), eq(agentDeployments.status, "active"))).limit(1);
  if (!d) return;
  const { effectiveConfig } = await import("../services/agent-config");
  const { config } = await effectiveConfig(w);
  for (const wf of config.workflows.filter((x) => x.trigger.type === "event" && x.trigger.value === event)) {
    await enqueue({ type: "workflow.scheduled", workspaceId: w.workspaceId, payload: { workflowKey: wf.key, input: JSON.stringify({ assetId: input.assetId }), trigger: `event:${event}` }, dedupeKey: `event:${wf.key}:${input.assetId}` });
  }
}

/** Periodic housekeeping, run by the worker once a minute. Dedupe keys make it safe on many workers. */
export async function scheduleTick(now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  await enqueue({ type: "retention.sweep", payload: {}, dedupeKey: `retention:${day}` }).catch(() => undefined);

  const deployments = await db.select({ d: agentDeployments }).from(agentDeployments).innerJoin(workspaces, eq(workspaces.id, agentDeployments.workspaceId))
    .where(and(eq(agentDeployments.status, "active"), eq(workspaces.status, "active")));
  const week = `${now.getUTCFullYear()}-w${Math.floor((now.getTime() / 864e5 + 4) / 7)}`;
  for (const { d } of deployments) {
    const { effectiveConfig } = await import("../services/agent-config");
    const { config } = await effectiveConfig({ workspaceId: d.workspaceId });
    for (const wf of config.workflows.filter((w) => w.trigger.type === "schedule" && w.inputs.every((i) => !i.required))) {
      const period = wf.trigger.value === "weekly" ? week : day;
      await enqueue({ type: "workflow.scheduled", workspaceId: d.workspaceId, payload: { workflowKey: wf.key, input: "{}" }, dedupeKey: `sched:${d.id}:${wf.key}:${period}` }).catch(() => undefined);
    }
    const refresh = config.modules.ideation.refresh;
    if (refresh !== "manual") {
      const period = refresh === "weekly" ? week : day;
      await enqueue({ type: "channel.sync", workspaceId: d.workspaceId, payload: { maxVideos: "200" }, dedupeKey: `refresh:${d.workspaceId}:${period}` }).catch(() => undefined);
    }
  }
}
