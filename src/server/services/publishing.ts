import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { tzOffsetMinutes } from "@/lib/dates";
import { contentIdeas, mediaAssets, publishingJobs, renderJobs } from "@/db/schema";
import { edlSchema, rangeToTimeline, timelineCues, toSrt, type TranscriptSegment } from "@/lib/edl";
import { AppError, conflict, forbidden, notConfigured, notFound, PermanentError, validationError } from "@/lib/errors";
import { chaptersBlock, fitTags, metadataSuggestionsSchema, normalizeChapters, publishMetadataSchema, renderDescription, type PublishMetadata } from "@/lib/metadata";
import { metadataOutput } from "../ai/schemas";
import { UploadSessionExpired } from "../providers/youtube";
import { decrypt, encrypt } from "../secrets";
import { driver } from "../storage";
import type { WorkspaceCtx } from "../tenancy";
import { effectiveConfig } from "./agent-config";
import { auditWs } from "./audit";
import { createApproval } from "./approvals";
import { workspacePlaylists } from "./channel";
import { getEdit, getTranscript } from "./editing";
import { getYouTube, resolveConnection } from "./integrations";
import { callLlm } from "./llm-call";
import { extOf, getAsset, scratch } from "./media";
import { getRender } from "./render";
import { getProfile } from "./workspaces";

export type PublishingJob = typeof publishingJobs.$inferSelect;

export async function getPublishing(ws: Pick<WorkspaceCtx, "workspaceId">, id: string, conn: DbOrTx = db): Promise<PublishingJob> {
  const [row] = await conn.select().from(publishingJobs).where(and(eq(publishingJobs.id, id), eq(publishingJobs.workspaceId, ws.workspaceId))).limit(1);
  if (!row) throw notFound("Publishing job not found.");
  return row;
}

export async function listPublishing(ws: WorkspaceCtx) {
  return db.select({ job: publishingJobs, asset: mediaAssets }).from(publishingJobs).innerJoin(mediaAssets, eq(mediaAssets.id, publishingJobs.outputAssetId))
    .where(eq(publishingJobs.workspaceId, ws.workspaceId)).orderBy(desc(publishingJobs.createdAt)).limit(200);
}

/**
 * Creates the publishing job for a finished render, with AI-drafted metadata
 * when `useAi` (requires an LLM) or a blank editable draft otherwise.
 * Idempotent per render output.
 */
export async function createPublishingJob(ws: WorkspaceCtx, opts: { renderJobId: string; useAi: boolean }) {
  const render = await getRender(ws, opts.renderJobId);
  if (render.status !== "succeeded" || !render.outputAssetId) throw validationError("The render has not finished successfully yet.");
  const key = `publish:${render.outputAssetId}`;
  const [existing] = await db.select().from(publishingJobs).where(and(eq(publishingJobs.idempotencyKey, key), eq(publishingJobs.workspaceId, ws.workspaceId))).limit(1);
  if (existing) return existing;

  const ep = await getEdit(ws, render.editProjectId);
  const out = await getAsset(ws, render.outputAssetId);
  const { config } = await effectiveConfig(ws);
  const pub = config.modules.publishing;
  const seo = config.seo;
  const edl = edlSchema.parse(ep.edl);

  let metadata: PublishMetadata = publishMetadataSchema.parse({
    title: ep.title.slice(0, 100).replace(/[<>]/g, "") || "Untitled", description: "", categoryId: pub.categoryId,
    privacyStatus: pub.defaultPrivacy, madeForKids: pub.madeForKids,
  });
  let suggestions = metadataSuggestionsSchema.parse({});
  let provider: string | null = null, isMock = false;

  if (opts.useAi) {
    const idea = ep.ideaId ? (await db.select().from(contentIdeas).where(and(eq(contentIdeas.id, ep.ideaId), eq(contentIdeas.workspaceId, ws.workspaceId))))[0] : null;
    const profile = await getProfile(ws);
    const pls = await workspacePlaylists(ws);
    // Transcript segments with their position on the CUT timeline; segments that were cut are excluded.
    const intro = edl.branding.introAssetId ? (await getAsset(ws, edl.branding.introAssetId)).durationSeconds ?? 0 : 0;
    const segs: { seg: string; t: number; text: string }[] = [];
    for (const src of edl.sources) {
      const t = await getTranscript(ws, src.assetId);
      for (const s of (t?.segments ?? []) as TranscriptSegment[]) {
        const at = rangeToTimeline(edl.clips, src.id, s.start, s.end);
        if (at !== null) segs.push({ seg: `${src.id}:${s.id}`, t: Math.round(at + intro), text: s.text });
      }
    }
    if (!segs.length) throw notConfigured("This video has no transcript, so metadata cannot be grounded in its content. Transcribe the recording first, or create a blank draft.");
    const llm = await callLlm(ws, config, {
      schemaName: "publish_metadata", schema: metadataOutput, instructions: config.instructions.metadata,
      task: [
        `Draft YouTube metadata for this video. Provide ${seo.titleOptions} title options of at most ${seo.maxTitleChars} characters.`,
        `Write a factual summary of what the video actually covers (from the transcript). Suggest chapters by seg id where the topic changes.`,
        `Up to ${seo.maxTags} relevant tags and ${seo.maxHashtags} hashtags. No keyword stuffing, no misleading claims, no irrelevant hashtags.`,
        `Avoid these phrases: ${seo.bannedPhrases.join(", ") || "none"}. CTA guidance: ${seo.ctaGuidance}`,
        "Suggest playlists only from the provided playlists. Thumbnail concepts must depict what is really in the video.",
      ].join(" "),
      data: {
        idea: idea ? { title: idea.title, concept: idea.concept, audience: idea.targetAudience, keywords: idea.keywords } : null,
        creator: { niche: profile.niche, audience: profile.targetAudience, tone: profile.tone, goals: profile.goals },
        durationSeconds: Math.round(out.durationSeconds ?? 0),
        playlists: pls.map((p) => ({ playlistId: p.youtubePlaylistId, title: p.title })),
        transcript: segs.slice(0, 2000),
      },
    });
    const m = llm.data;
    const banned = seo.bannedPhrases.map((b) => b.toLowerCase());
    const clean = (s: string) => s.replace(/[<>]/g, "").trim();
    const titles = m.titleOptions.map((t) => clean(t).slice(0, seo.maxTitleChars)).filter((t) => t && !banned.some((b) => t.toLowerCase().includes(b)));
    const segAt = new Map(segs.map((s) => [s.seg, s.t]));
    const chapters = seo.includeChapters
      ? normalizeChapters(m.chapters.map((c) => ({ start: segAt.get(c.segmentId) ?? -1, title: clean(c.title) })).filter((c) => c.start >= 0), out.durationSeconds ?? 0)
      : { chapters: [] };
    const hashtags = m.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`).replace(/\s+/g, "")).filter((h) => /^#[\p{L}\p{N}_]{1,60}$/u.test(h)).slice(0, seo.maxHashtags);
    const plIds = new Set(pls.map((p) => p.youtubePlaylistId));
    metadata = publishMetadataSchema.parse({
      ...metadata,
      title: titles[0] ?? metadata.title,
      description: renderDescription(seo.descriptionTemplate, { summary: clean(m.summary), chapters: chaptersBlock(chapters.chapters), cta: clean(m.cta), hashtags }).slice(0, 4900),
      tags: fitTags(m.tags, seo.maxTags), hashtags, chapters: chapters.chapters, pinnedComment: clean(m.pinnedComment).slice(0, 2000),
    });
    suggestions = metadataSuggestionsSchema.parse({
      titleOptions: titles.slice(0, 10), cta: clean(m.cta).slice(0, 500),
      thumbnailConcepts: m.thumbnailConcepts.slice(0, 6).map((t) => ({ concept: clean(t.concept).slice(0, 400), textOverlay: clean(t.textOverlay).slice(0, 60) })),
      playlistSuggestions: m.playlistSuggestions.filter((p) => plIds.has(p.playlistId)).slice(0, 5).map((p) => ({ playlistId: p.playlistId, title: pls.find((x) => x.youtubePlaylistId === p.playlistId)!.title, reason: clean(p.reason).slice(0, 300) })),
      notes: [...m.notes.map((n) => clean(n).slice(0, 300)).slice(0, 6), ...(chapters.problem ? [chapters.problem] : [])],
    });
    provider = `${llm.provider}/${llm.model}`;
    isMock = llm.isMock;
  }

  const youtube = await resolveConnection(ws, "youtube_connection", "youtube");
  const [row] = await db.insert(publishingJobs).values({
    workspaceId: ws.workspaceId, editProjectId: ep.id, renderJobId: render.id, outputAssetId: out.id, connectionId: youtube?.id ?? null,
    status: "draft", metadata, suggestions, metadataProvider: provider, isMock, idempotencyKey: key, createdBy: ws.actorId,
  }).onConflictDoNothing().returning();
  if (!row) return (await db.select().from(publishingJobs).where(eq(publishingJobs.idempotencyKey, key)))[0];
  await auditWs(ws, { action: "publishing.create", entityType: "publishing_job", entityId: row.id, summary: `Prepared metadata for "${metadata.title}"${provider ? ` (${provider})` : ""}` });
  return row;
}

/** Every field is editable. Editing an approved job sends it back for approval. */
export async function updateMetadata(ws: WorkspaceCtx, id: string, input: unknown) {
  const job = await getPublishing(ws, id);
  if (["uploading", "processing", "scheduled", "published"].includes(job.status)) throw conflict("This video has already been sent to YouTube; change it in YouTube Studio.");
  const m = publishMetadataSchema.parse(input);
  validateSchedule(m);
  const status = job.status === "approved" ? "awaiting_approval" : job.status === "failed" ? "draft" : job.status;
  await db.update(publishingJobs).set({ metadata: m, status, approvedBy: status === "awaiting_approval" ? null : job.approvedBy, approvedAt: status === "awaiting_approval" ? null : job.approvedAt, updatedAt: new Date() }).where(eq(publishingJobs.id, job.id));
  if (job.status === "approved") await createApproval(ws, { kind: "publish", title: `Approve upload: ${m.title}`, subjectType: "publishing_job", subjectId: job.id });
  await auditWs(ws, { action: "publishing.edit", entityType: "publishing_job", entityId: job.id, summary: `Edited metadata for "${m.title}"` });
}

function validateSchedule(m: PublishMetadata) {
  if (m.publishAt) {
    if (m.privacyStatus !== "private") throw validationError("YouTube requires visibility \"private\" for scheduled videos; it becomes public at the scheduled time.");
    if (new Date(m.publishAt).getTime() < Date.now() + 15 * 60_000) throw validationError("Schedule at least 15 minutes in the future.");
  }
}

/** Moves a draft into the approval queue (or straight to approved under authorised rule-based publishing). */
export async function submitPublishing(ws: WorkspaceCtx, id: string, opts: { workflowRunId?: string; stepRunId?: string } = {}) {
  const job = await getPublishing(ws, id);
  if (job.status !== "draft" && job.status !== "awaiting_approval") return job;
  const { config } = await effectiveConfig(ws);
  const pub = config.modules.publishing;
  if (!pub.enabled) throw notConfigured("Publishing is disabled in this workspace's agent configuration.");
  const m = publishMetadataSchema.parse(job.metadata);

  if (pub.mode === "rule_based" && ruleAllows(ws, pub, m)) {
    const scheduled = m.publishAt ? m : applyScheduleRule(m, pub.rules, ws.timezone);
    await db.update(publishingJobs).set({ status: "approved", metadata: scheduled, approvedAt: new Date(), updatedAt: new Date() }).where(eq(publishingJobs.id, job.id));
    await auditWs(ws, { action: "publishing.auto_approve", entityType: "publishing_job", entityId: job.id, summary: `Auto-approved under the workspace's standing publishing authorisation (${scheduled.privacyStatus})` });
    return { ...job, status: "approved" as const };
  }
  await db.update(publishingJobs).set({ status: "awaiting_approval", updatedAt: new Date() }).where(eq(publishingJobs.id, job.id));
  await createApproval(ws, { kind: "publish", title: `Approve upload: ${m.title}`, subjectType: "publishing_job", subjectId: job.id, workflowRunId: opts.workflowRunId, stepRunId: opts.stepRunId });
  return { ...job, status: "awaiting_approval" as const };
}

function ruleAllows(ws: WorkspaceCtx, pub: { rules: { autoPrivacy: "private" | "unlisted" } }, m: PublishMetadata): boolean {
  if (!ws.settings.autoPublishAuthorized) return false;
  const rank = { private: 0, unlisted: 1, public: 2 };
  // Scheduled videos are uploaded private and only go public at publishAt; that still needs the owner's sign-off.
  if (m.publishAt) return false;
  return rank[m.privacyStatus] <= rank[pub.rules.autoPrivacy];
}

/** Next configured weekday/time slot in the workspace timezone (≥ 1 hour away). */
export function applyScheduleRule(m: PublishMetadata, rules: { scheduleDays: string[]; scheduleTime: string }, timezone: string, now = new Date()): PublishMetadata {
  if (!rules.scheduleDays.length) return m;
  const [hh, mm] = rules.scheduleTime.split(":").map(Number);
  for (let d = 0; d < 14; d++) {
    const day = new Date(now.getTime() + d * 864e5);
    const local = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(day);
    const get = (t: string) => local.find((p) => p.type === t)!.value;
    if (!rules.scheduleDays.includes(get("weekday").toLowerCase().slice(0, 3))) continue;
    const guess = new Date(Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")), hh, mm));
    const offset = tzOffsetMinutes(guess, timezone);
    const at = new Date(guess.getTime() - offset * 60_000);
    if (at.getTime() > now.getTime() + 3600_000) return { ...m, privacyStatus: "private", publishAt: at.toISOString() };
  }
  return m;
}


/** Explicit approval by an authorised workspace member (via the approvals service). */
export async function markPublishingApproved(ws: WorkspaceCtx, id: string, conn: DbOrTx = db) {
  const job = await getPublishing(ws, id, conn);
  if (job.status !== "awaiting_approval" && job.status !== "draft") throw conflict(`Cannot approve a job that is ${job.status.replace("_", " ")}.`);
  if (!ws.actorId) throw forbidden("Publishing approval must come from a person.");
  validateSchedule(publishMetadataSchema.parse(job.metadata));
  await conn.update(publishingJobs).set({ status: "approved", approvedBy: ws.actorId, approvedAt: new Date(), updatedAt: new Date() }).where(eq(publishingJobs.id, job.id));
  await auditWs(ws, { action: "publishing.approve", entityType: "publishing_job", entityId: job.id, summary: `Approved upload of "${(job.metadata as PublishMetadata).title}"` }, conn);
}

export async function cancelPublishing(ws: WorkspaceCtx, id: string) {
  const job = await getPublishing(ws, id);
  if (["uploading", "processing", "scheduled", "published"].includes(job.status)) throw conflict("The upload has already started.");
  await db.update(publishingJobs).set({ status: "cancelled", updatedAt: new Date() }).where(eq(publishingJobs.id, job.id));
  await auditWs(ws, { action: "publishing.cancel", entityType: "publishing_job", entityId: job.id, summary: "Cancelled a publishing job" });
}

/* ── upload (worker) ──────────────────────────────────────────────────── */

/**
 * Uploads an approved job. Safe to run more than once:
 *   - a row lock moves the job to "uploading" so two workers cannot both upload;
 *   - once YouTube returns a video id it is stored and never uploaded again;
 *   - an interrupted upload resumes from the byte YouTube confirms it has.
 */
export async function runUpload(ws: WorkspaceCtx, id: string, ctx: { signal: AbortSignal; progress: (p: number, note?: string) => Promise<void> }) {
  const job = await getPublishing(ws, id);
  if (job.youtubeVideoId) return { youtubeVideoId: job.youtubeVideoId, status: job.status };
  if (job.status === "cancelled") throw new PermanentError("The publishing job was cancelled.");
  if (!job.approvedAt) throw new PermanentError("This video has not been approved for publishing.");
  if (!["approved", "uploading", "failed"].includes(job.status)) throw new PermanentError(`Cannot upload a job that is ${job.status}.`);

  const { config } = await effectiveConfig(ws);
  if (!config.modules.publishing.enabled) throw new PermanentError("Publishing is disabled for this workspace.");
  const { api, connection, scopes } = await getYouTube(ws);
  if (!scopes.includes("youtube.upload")) throw notConfigured("The YouTube connection was not granted upload permission. Reconnect the channel with publishing enabled.");

  const [locked] = await db.update(publishingJobs).set({ status: "uploading", attempts: job.attempts + 1, connectionId: connection.id, updatedAt: new Date(), error: null })
    .where(and(eq(publishingJobs.id, job.id), inArray(publishingJobs.status, ["approved", "failed", "uploading"]), eq(publishingJobs.attempts, job.attempts))).returning();
  if (!locked) throw new AppError("CONFLICT", "Another worker is handling this upload.");

  const m = publishMetadataSchema.parse(job.metadata);
  const asset = await getAsset(ws, job.outputAssetId);
  const d = await driver(asset.storageDriver);
  const { join } = await import("node:path");
  const { mkdir, rm } = await import("node:fs/promises");
  const work = scratch("publish", job.id);
  await mkdir(work, { recursive: true });
  try {
    const file = await d.toLocalFile(asset.storageKey, join(work, `video.${extOf(asset.storageKey)}`));
    let session = job.uploadSessionCiphertext ? decrypt(job.uploadSessionCiphertext) : null;
    let offset = 0;
    if (session) {
      try {
        const st = await api.uploadStatus(session, asset.sizeBytes);
        if (st.video) return await finishUpload(ws, job, st.video.id);
        offset = st.received;
      } catch (e) {
        if (!(e instanceof UploadSessionExpired)) throw e;
        session = null;
      }
    }
    if (!session) {
      const description = m.description;
      session = await api.startUpload({
        snippet: { title: m.title, description, tags: m.tags, categoryId: m.categoryId, defaultLanguage: m.language, defaultAudioLanguage: m.language },
        status: { privacyStatus: m.privacyStatus, selfDeclaredMadeForKids: m.madeForKids, ...(m.publishAt ? { publishAt: m.publishAt } : {}) },
      }, asset.sizeBytes, asset.mimeType);
      await db.update(publishingJobs).set({ uploadSessionCiphertext: encrypt(session) }).where(eq(publishingJobs.id, job.id));
    }
    const video = await api.uploadFrom(session, file, offset, async (bytes) => {
      await db.update(publishingJobs).set({ bytesUploaded: bytes }).where(eq(publishingJobs.id, job.id));
      await ctx.progress((bytes / asset.sizeBytes) * 95, "Uploading to YouTube");
    }, ctx.signal);
    return await finishUpload(ws, job, video.id);
  } catch (err) {
    await db.update(publishingJobs).set({ status: "failed", error: err instanceof Error ? err.message.slice(0, 1000) : "Upload failed", updatedAt: new Date() }).where(and(eq(publishingJobs.id, job.id), eq(publishingJobs.status, "uploading")));
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function finishUpload(ws: WorkspaceCtx, job: PublishingJob, videoId: string) {
  await db.update(publishingJobs).set({ youtubeVideoId: videoId, status: "processing", uploadSessionCiphertext: null, updatedAt: new Date(), error: null }).where(eq(publishingJobs.id, job.id));
  await auditWs(ws, { action: "publishing.uploaded", entityType: "publishing_job", entityId: job.id, summary: `Uploaded to YouTube (video ${videoId})` });
  // Optional follow-ups that need extra permission; their outcome is recorded, never assumed.
  const notes: string[] = [];
  const { config } = await effectiveConfig(ws);
  const { api, scopes } = await getYouTube(ws);
  const m = publishMetadataSchema.parse(job.metadata);
  const canWrite = scopes.includes("youtube.force-ssl");
  if (config.modules.publishing.uploadCaptions) {
    if (!canWrite) notes.push("Captions not uploaded: the connection lacks the youtube.force-ssl scope.");
    else {
      const render = job.renderJobId ? await getRender(ws, job.renderJobId) : null;
      const ep = job.editProjectId ? await getEdit(ws, job.editProjectId) : null;
      if (render && ep) {
        const edl = edlSchema.parse(ep.edl);
        try { await api.insertCaption(videoId, m.language, "Captions", toSrt(timelineCues(edl.clips, edl.captions.cues))); notes.push("Captions uploaded."); }
        catch (e) { notes.push(`Captions failed: ${e instanceof Error ? e.message : "error"}`); }
      }
    }
  }
  if (m.playlistId) {
    if (!canWrite) notes.push("Not added to playlist: the connection lacks the youtube.force-ssl scope.");
    else { try { await api.addToPlaylist(m.playlistId, videoId); notes.push("Added to playlist."); } catch (e) { notes.push(`Playlist add failed: ${e instanceof Error ? e.message : "error"}`); } }
  }
  if (m.pinnedComment) notes.push("Pinned comment is a draft: the YouTube API cannot pin comments; post and pin it in YouTube Studio.");
  await db.update(publishingJobs).set({ youtubeStatus: { notes } }).where(eq(publishingJobs.id, job.id));
  return { youtubeVideoId: videoId, status: "processing" as const };
}

/** Polls YouTube for processing status. Returns done=false while YouTube is still processing. */
export async function trackPublishing(ws: WorkspaceCtx, id: string) {
  const job = await getPublishing(ws, id);
  if (!job.youtubeVideoId) throw new PermanentError("Nothing has been uploaded for this job.");
  const { api } = await getYouTube(ws);
  const st = await api.videoStatus(job.youtubeVideoId);
  if (!st) throw new PermanentError("YouTube no longer has this video.");
  const prev = (job.youtubeStatus ?? {}) as { notes?: string[] };
  let status: PublishingJob["status"] = "processing";
  if (st.uploadStatus === "failed" || st.uploadStatus === "rejected") status = "failed";
  else if (st.uploadStatus === "processed") status = st.publishAt ? "scheduled" : "published";
  await db.update(publishingJobs).set({
    status, youtubeStatus: { ...prev, ...st }, updatedAt: new Date(),
    error: status === "failed" ? `YouTube ${st.uploadStatus}: ${st.failureReason ?? st.rejectionReason ?? "unknown"}` : null,
  }).where(eq(publishingJobs.id, job.id));
  if (status === "published" || status === "scheduled") {
    const ep = job.editProjectId ? await getEdit(ws, job.editProjectId) : null;
    if (ep?.ideaId) await db.update(contentIdeas).set({ status: "published" }).where(and(eq(contentIdeas.id, ep.ideaId), eq(contentIdeas.workspaceId, ws.workspaceId)));
  }
  return { status, done: status !== "processing" };
}

export async function renderOutputs(ws: WorkspaceCtx) {
  return db.select({ render: renderJobs, asset: mediaAssets }).from(renderJobs).innerJoin(mediaAssets, eq(mediaAssets.id, renderJobs.outputAssetId))
    .where(and(eq(renderJobs.workspaceId, ws.workspaceId), eq(renderJobs.status, "succeeded"))).orderBy(desc(renderJobs.finishedAt)).limit(100);
}
