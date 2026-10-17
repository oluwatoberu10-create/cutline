import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { editProjects, mediaAssets, renderJobs } from "@/db/schema";
import { edlSchema, timelineCues, timelineDuration, toAss, toSrt, type Edl } from "@/lib/edl";
import { conflict, notFound, PermanentError, RetryLater, validationError } from "@/lib/errors";
import { buildRenderPlan, type PlanSource } from "@/lib/render-plan";
import { enqueue } from "../jobs/queue";
import { ffmpeg, probe } from "../media/ffmpeg";
import { driver, storageKey } from "../storage";
import type { WorkspaceCtx } from "../tenancy";
import { effectiveConfig } from "./agent-config";
import { auditWs, checkUsage, recordUsage } from "./audit";
import { approveEdit, getEdit } from "./editing";
import { storageDriverIdFor } from "./integrations";
import { extOf, getAsset, scratch } from "./media";

export type RenderJob = typeof renderJobs.$inferSelect;

/**
 * Queues a render. Idempotent per (edit, EDL version, kind, preset): asking
 * again returns the existing render, and retrying a failed one reuses its row.
 * Final renders require the current EDL version to be approved.
 */
export async function requestRender(ws: WorkspaceCtx, editId: string, kind: "draft" | "final", opts: { enqueue?: boolean } = {}) {
  const ep = await getEdit(ws, editId);
  const { config } = await effectiveConfig(ws);
  const edl = edlSchema.parse(ep.edl);
  if (!edl.clips.length) throw validationError("The edit has no clips to render.");

  if (kind === "final") {
    if (ep.editingMode === "automatic" && ep.approvedVersion !== ep.edlVersion) await approveEdit(ws, ep.id);
    else if (ep.approvedVersion !== ep.edlVersion) throw validationError("Approve the current version of this edit before rendering the final video.");
  }
  const presetId = kind === "draft" && ep.format !== "short" ? config.modules.editing.presets.draft : edl.output.presetId;
  const preset = config.renderPresets.find((p) => p.id === presetId);
  if (!preset) throw validationError(`Render preset "${presetId}" is not defined in the agent configuration.`);
  await checkUsage(ws, "render_minutes", timelineDuration(edl.clips) / 60);

  const key = `render:${ep.id}:${ep.edlVersion}:${kind}:${preset.id}`;
  const [existing] = await db.select().from(renderJobs).where(and(eq(renderJobs.idempotencyKey, key), eq(renderJobs.workspaceId, ws.workspaceId))).limit(1);
  if (existing && existing.status !== "failed" && existing.status !== "cancelled") return existing;

  const row = existing
    ? (await db.update(renderJobs).set({ status: "queued", error: null, progress: 0 }).where(eq(renderJobs.id, existing.id)).returning())[0]
    : (await db.insert(renderJobs).values({ workspaceId: ws.workspaceId, editProjectId: ep.id, kind, edlVersion: ep.edlVersion, output: preset, idempotencyKey: key, createdBy: ws.actorId }).returning())[0];
  if (opts.enqueue !== false) await enqueue({ type: "render.execute", workspaceId: ws.workspaceId, payload: { renderJobId: row.id }, dedupeKey: `render:${row.id}`, timeoutSeconds: config.policies.timeouts.renderSeconds, maxAttempts: config.policies.retry.maxAttempts, createdBy: ws.actorId });
  if (kind === "final") await db.update(editProjects).set({ status: "rendering" }).where(eq(editProjects.id, ep.id));
  await auditWs(ws, { action: `render.${kind}`, entityType: "render_job", entityId: row.id, summary: `Queued ${kind} render of "${ep.title}" (${preset.label})` });
  return row;
}

export async function getRender(ws: Pick<WorkspaceCtx, "workspaceId">, id: string): Promise<RenderJob> {
  const [r] = await db.select().from(renderJobs).where(and(eq(renderJobs.id, id), eq(renderJobs.workspaceId, ws.workspaceId))).limit(1);
  if (!r) throw notFound("Render not found.");
  return r;
}

export async function rendersFor(ws: WorkspaceCtx, editId: string) {
  return db.select().from(renderJobs).where(and(eq(renderJobs.editProjectId, editId), eq(renderJobs.workspaceId, ws.workspaceId))).orderBy(desc(renderJobs.createdAt));
}

/** Runs in the worker. Marks success only after FFprobe confirms a playable output of the right length. */
export async function executeRender(ws: WorkspaceCtx, renderJobId: string, ctx: { jobId: string; signal: AbortSignal; progress: (p: number, note?: string) => Promise<void> }) {
  const job = await getRender(ws, renderJobId);
  if (job.status === "succeeded" && job.outputAssetId) return { renderJobId: job.id, outputAssetId: job.outputAssetId, reused: true };
  const ep = await getEdit(ws, job.editProjectId);
  if (ep.edlVersion !== job.edlVersion) throw new PermanentError("The edit changed after this render was queued; request a new render.");
  const edl: Edl = edlSchema.parse(ep.edl);
  const preset = job.output as Parameters<typeof buildRenderPlan>[0]["preset"];

  // Atomic claim: only one executor may render a given row. A "running" row is reclaimable
  // once it is older than the render timeout (its worker died).
  const { config } = await effectiveConfig(ws);
  const stale = new Date(Date.now() - config.policies.timeouts.renderSeconds * 1000);
  const [claimed] = await db.update(renderJobs).set({ status: "running", startedAt: new Date(), progress: 0, error: null })
    .where(and(eq(renderJobs.id, job.id), or(inArray(renderJobs.status, ["queued", "failed", "cancelled"]), and(eq(renderJobs.status, "running"), lt(renderJobs.startedAt, stale))))).returning();
  if (!claimed) throw new RetryLater(30, "This render is already being produced by another worker.");
  const work = scratch("jobs", ctx.jobId);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    await ctx.progress(1, "Fetching source media");
    const sources: Record<string, PlanSource> = {};
    for (const [i, s] of edl.sources.entries()) {
      const a = await getAsset(ws, s.assetId);
      if (a.status !== "ready") throw new PermanentError(`Source "${a.originalFilename}" is not ready.`);
      const name = `src${i}.${extOf(a.storageKey)}`;
      await linkOrFetch(a, join(work, name));
      sources[s.id] = { file: name, hasVideo: a.hasVideo, hasAudio: a.hasAudio, duration: a.durationSeconds ?? 0 };
    }
    const extra = async (id: string | null, name: string): Promise<PlanSource | null> => {
      if (!id) return null;
      const a = await getAsset(ws, id);
      const file = `${name}.${extOf(a.storageKey)}`;
      await linkOrFetch(a, join(work, file));
      return { file, hasVideo: a.hasVideo, hasAudio: a.hasAudio, duration: a.durationSeconds ?? 0 };
    };
    const intro = await extra(edl.branding.introAssetId, "intro_src");
    const outro = await extra(edl.branding.outroAssetId, "outro_src");
    const logo = edl.branding.logoAssetId ? { file: (await extra(edl.branding.logoAssetId, "logo"))!.file } : null;

    // Captions are mapped onto the cut timeline (shifted by the intro).
    const offset = intro?.duration ?? 0;
    const cues = timelineCues(edl.clips, edl.captions.cues).map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
    const burn = edl.captions.enabled && edl.captions.burnIn;
    let assFile: string | null = null;
    if (burn || edl.lowerThirds.length) {
      assFile = "captions.ass";
      await writeFile(join(work, assFile), toAss({ width: preset.width, height: preset.height, style: edl.captions.style, cues, lowerThirds: edl.lowerThirds.map((l) => ({ ...l, start: l.start + offset })), captions: burn }));
    }

    const outName = `output.${preset.container}`;
    const plan = buildRenderPlan({ edl, preset, sources, intro, outro, logo, assFile, outputFile: outName });
    await writeFile(join(work, "segments.txt"), plan.concatList);

    // Progress: segment encodes are weighted 60%, the finishing pass 40%.
    const segTotal = plan.steps.slice(0, -1).reduce((s, x) => s + x.seconds, 0) || 1;
    let segDone = 0;
    for (const [i, step] of plan.steps.entries()) {
      const final = i === plan.steps.length - 1;
      await ctx.progress(final ? 60 : 2 + (segDone / segTotal) * 58, final ? "Finishing: captions, branding, audio" : step.label);
      await ffmpeg(step.args, {
        cwd: work, signal: ctx.signal,
        onProgress: (sec) => {
          const pct = final ? 60 + Math.min(1, sec / Math.max(1, step.seconds)) * 38 : 2 + ((segDone + Math.min(sec, step.seconds)) / segTotal) * 58;
          void ctx.progress(pct);
          void db.update(renderJobs).set({ progress: Math.round(pct) }).where(eq(renderJobs.id, job.id));
        },
      });
      if (!final) segDone += step.seconds;
    }

    const outPath = join(work, outName);
    const out = await probe(outPath);
    if (!out.hasVideo || !out.hasAudio) throw new Error("Render produced a file without both audio and video.");
    if (Math.abs(out.duration - plan.timelineSeconds) > Math.max(1.5, plan.timelineSeconds * 0.02)) {
      throw new Error(`Rendered duration ${out.duration.toFixed(2)}s does not match the timeline (${plan.timelineSeconds.toFixed(2)}s).`);
    }

    await ctx.progress(99, "Storing output");
    const assetId = randomUUID();
    const driverId = await storageDriverIdFor(ws);
    const d = await driver(driverId);
    const key = storageKey(ws.workspaceId, "renders", assetId, `render.${preset.container}`);
    const size = (await stat(outPath)).size;
    const srtPath = join(work, "captions.srt");
    await writeFile(srtPath, toSrt(cues));
    const captionsKey = storageKey(ws.workspaceId, "captions", assetId, "captions.srt");
    await d.putFile(captionsKey, srtPath, "application/x-subrip");
    await d.putFile(key, outPath, preset.container === "webm" ? "video/webm" : "video/mp4");

    await db.transaction(async (tx) => {
      await tx.insert(mediaAssets).values({
        id: assetId, workspaceId: ws.workspaceId, projectId: ep.projectId, kind: "video", role: "render", status: "ready",
        originalFilename: `${ep.title.replace(/[^\w\- ]+/g, "").slice(0, 80) || "render"} (${job.kind} ${preset.label}).${preset.container}`,
        mimeType: preset.container === "webm" ? "video/webm" : "video/mp4", sizeBytes: size, storageDriver: driverId, storageKey: key, proxyKey: key,
        probe: out.raw as object, durationSeconds: out.duration, width: out.width, height: out.height, fps: out.fps, hasVideo: true, hasAudio: true, createdBy: job.createdBy,
      });
      await tx.update(renderJobs).set({ status: "succeeded", progress: 100, outputAssetId: assetId, captionsKey, finishedAt: new Date(), error: null }).where(eq(renderJobs.id, job.id));
      if (job.kind === "final") await tx.update(editProjects).set({ status: "rendered" }).where(and(eq(editProjects.id, ep.id), eq(editProjects.edlVersion, job.edlVersion)));
    });
    await recordUsage(ws.workspaceId, "render_minutes", plan.timelineSeconds / 60);
    return { renderJobId: job.id, outputAssetId: assetId, reused: false };
  } catch (err) {
    await db.update(renderJobs).set({ status: ctx.signal.aborted ? "cancelled" : "failed", error: err instanceof Error ? err.message.slice(0, 1000) : "Render failed" }).where(eq(renderJobs.id, job.id));
    if (job.kind === "final") await db.update(editProjects).set({ status: "failed" }).where(and(eq(editProjects.id, ep.id), eq(editProjects.status, "rendering")));
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Local storage: hard-link (no copy) when possible; remote storage: download. */
async function linkOrFetch(asset: { storageDriver: string; storageKey: string }, dest: string) {
  const d = await driver(asset.storageDriver);
  if (asset.storageDriver === "local") {
    const src = await d.toLocalFile(asset.storageKey, dest);
    const { link, copyFile } = await import("node:fs/promises");
    try { await link(src, dest); } catch { await copyFile(src, dest); }
    return;
  }
  await d.toLocalFile(asset.storageKey, dest);
}

export async function cancelRender(ws: WorkspaceCtx, renderJobId: string) {
  const r = await getRender(ws, renderJobId);
  if (r.status === "succeeded") throw conflict("This render already finished.");
  const { requestCancel } = await import("../jobs/queue");
  const { jobs } = await import("@/db/schema");
  const rows = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.dedupeKey, `render:${r.id}`), eq(jobs.workspaceId, ws.workspaceId)));
  for (const j of rows) await requestCancel({ jobId: j.id });
  await db.update(renderJobs).set({ status: "cancelled" }).where(and(eq(renderJobs.id, r.id), eq(renderJobs.status, "queued")));
}
