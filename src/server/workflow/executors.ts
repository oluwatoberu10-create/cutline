import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { editProjects, mediaAssets } from "@/db/schema";
import type { AgentConfig } from "@/lib/blueprint/schema";
import { PermanentError, RetryLater, validationError } from "@/lib/errors";
import type { Run, StepRun } from "./engine";
import type { WorkspaceCtx } from "../tenancy";
import { analyzeChannel, syncChannel } from "../services/channel";
import { createApproval } from "../services/approvals";
import { getEdit, proposeEdit, transcribeAsset } from "../services/editing";
import { generateIdeas } from "../services/ideas";
import { createPublishingJob, getPublishing, runUpload, submitPublishing, trackPublishing } from "../services/publishing";
import { executeRender, requestRender } from "../services/render";

/**
 * Executors for each registered node type. Every executor is idempotent:
 * re-running after a crash finds the work it already did (by step id, render
 * idempotency key or publishing state) instead of repeating side effects.
 */


export type ExecCtx = {
  ws: WorkspaceCtx;
  run: Run;
  step: StepRun;
  config: AgentConfig;
  params: Record<string, unknown>;
  jobId: string;
  signal: AbortSignal;
  progress: (p: number, note?: string) => Promise<void>;
};

export type ExecResult = { status: "succeeded" | "waiting"; output?: Record<string, unknown> };

const str = (v: unknown, what: string): string => {
  if (typeof v !== "string" || !v) throw new PermanentError(`Missing ${what}.`);
  return v;
};

async function render(ctx: ExecCtx, kind: "draft" | "final"): Promise<ExecResult> {
  const editId = str(ctx.params.edit, "edit project");
  const r = await requestRender(ctx.ws, editId, kind, { enqueue: false });
  if (r.status === "succeeded" && r.outputAssetId) return { status: "succeeded", output: { renderJobId: r.id, outputAssetId: r.outputAssetId } };
  const out = await executeRender(ctx.ws, r.id, ctx);
  return { status: "succeeded", output: { renderJobId: out.renderJobId, outputAssetId: out.outputAssetId } };
}

export const EXECUTORS: Record<string, (ctx: ExecCtx) => Promise<ExecResult>> = {
  "channel.sync": async (ctx) => {
    const r = await syncChannel(ctx.ws, { maxVideos: Number(ctx.params.maxVideos ?? 200) });
    return { status: "succeeded", output: { channelId: r.channelId, videosSynced: r.videosSynced, analyticsAvailable: r.analyticsAvailable } };
  },

  "channel.analyze": async (ctx) => {
    const r = await analyzeChannel(ctx.ws, { useLlm: ctx.params.useLlm !== false });
    return { status: "succeeded", output: { analysisId: r.analysisId, hasHypotheses: r.hasHypotheses, ...(r.llmNote ? { note: r.llmNote } : {}) } };
  },

  "ideas.generate": async (ctx) => {
    const r = await generateIdeas(ctx.ws, { count: ctx.params.count as number | undefined, focus: ctx.params.focus as string | undefined, batchKey: ctx.step.id });
    return { status: "succeeded", output: { batchId: r.batchId, ideaCount: r.ideaCount } };
  },

  "approval.gate": async (ctx) => {
    const kind = ctx.params.kind as string;
    const subject = typeof ctx.params.subject === "string" ? ctx.params.subject : null;
    const title = String(ctx.params.title ?? "Approval required");
    const link = { workflowRunId: ctx.run.id, stepRunId: ctx.step.id };

    if (kind === "edit" && subject) {
      const ep = await getEdit(ctx.ws, subject);
      if (ep.approvedVersion === ep.edlVersion) return { status: "succeeded", output: { decision: "approved", note: "Already approved in the editor." } };
      await db.update(editProjects).set({ status: "in_review" }).where(and(eq(editProjects.id, ep.id), eq(editProjects.workspaceId, ctx.ws.workspaceId)));
      const a = await createApproval(ctx.ws, { kind, title, subjectType: "edit_project", subjectId: ep.id, ...link });
      return { status: "waiting", output: { approvalId: a.id } };
    }
    if (kind === "publish" && subject) {
      const job = await submitPublishing(ctx.ws, subject, link);
      if (job.status === "approved") return { status: "succeeded", output: { decision: "approved", note: "Approved under the workspace's publishing rules." } };
      const a = await createApproval(ctx.ws, { kind, title, subjectType: "publishing_job", subjectId: subject, ...link });
      return { status: "waiting", output: { approvalId: a.id } };
    }
    const a = await createApproval(ctx.ws, { kind, title, subjectType: kind === "ideas" ? "idea_batch" : "custom", subjectId: subject, ...link });
    return { status: "waiting", output: { approvalId: a.id } };
  },

  "media.transcribe": async (ctx) => {
    const assetId = str(ctx.params.asset, "recording");
    const [a] = await db.select({ status: mediaAssets.status }).from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.workspaceId, ctx.ws.workspaceId))).limit(1);
    if (!a) throw new PermanentError("Recording not found.");
    if (a.status === "processing" || a.status === "uploading") throw new RetryLater(20, "Waiting for the recording to finish processing.");
    if (a.status === "failed") throw new PermanentError("The recording failed processing and cannot be transcribed.");
    const r = await transcribeAsset(ctx.ws, assetId, ctx);
    return { status: "succeeded", output: { transcriptId: r.transcriptId, segmentCount: r.segmentCount } };
  },

  "edit.propose": async (ctx) => {
    const r = await proposeEdit(ctx.ws, {
      assetId: str(ctx.params.asset, "recording"), ideaId: (ctx.params.idea as string | undefined) || null,
      useLlm: ctx.params.useLlm !== false, sourceKey: `step:${ctx.step.id}`,
    });
    return { status: "succeeded", output: { editProjectId: r.editProjectId, suggestionCount: r.suggestionCount, ...(r.llmNote ? { note: r.llmNote } : {}) } };
  },

  "render.draft": (ctx) => render(ctx, "draft"),
  "render.final": (ctx) => render(ctx, "final"),

  "metadata.generate": async (ctx) => {
    const job = await createPublishingJob(ctx.ws, { renderJobId: str(ctx.params.render, "render"), useAi: true });
    if (ctx.config.modules.publishing.mode === "rule_based") await submitPublishing(ctx.ws, job.id, { workflowRunId: ctx.run.id, stepRunId: ctx.step.id });
    return { status: "succeeded", output: { publishingJobId: job.id } };
  },

  "publish.upload": async (ctx) => {
    const id = str(ctx.params.publishingJob, "publishing job");
    const job = await getPublishing(ctx.ws, id);
    if (job.status === "awaiting_approval" || job.status === "draft") {
      // Rule-based mode without a standing authorisation lands here: wait for a person.
      const a = await createApproval(ctx.ws, { kind: "publish", title: "Approve upload to YouTube", subjectType: "publishing_job", subjectId: id, workflowRunId: ctx.run.id, stepRunId: ctx.step.id });
      if (job.status === "draft") await submitPublishing(ctx.ws, id, { workflowRunId: ctx.run.id, stepRunId: ctx.step.id });
      return { status: "waiting", output: { approvalId: a.id } };
    }
    if (job.status === "cancelled") throw new PermanentError("The publishing job was cancelled.");
    if (!job.approvedAt && !job.youtubeVideoId) throw validationError("Not approved for publishing.");
    const r = await runUpload(ctx.ws, id, ctx);
    return { status: "succeeded", output: { youtubeVideoId: r.youtubeVideoId, status: r.status } };
  },

  "publish.track": async (ctx) => {
    const r = await trackPublishing(ctx.ws, str(ctx.params.publishingJob, "publishing job"));
    if (!r.done) {
      const started = ctx.step.startedAt?.getTime() ?? Date.now();
      if (Date.now() - started < 6 * 3600_000) throw new RetryLater(60, "YouTube is still processing the video.");
      return { status: "succeeded", output: { status: "processing", note: "Stopped tracking after 6 hours; check YouTube Studio." } };
    }
    return { status: "succeeded", output: { status: r.status } };
  },
};
