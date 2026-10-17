import "server-only";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, type DbOrTx } from "@/db";
import { approvalRequests, contentIdeas, editProjects, editSuggestions, edlRevisions, mediaAssets, transcripts } from "@/db/schema";
import type { AgentConfig } from "@/lib/blueprint/schema";
import { cuesFromTranscript, edlSchema, keepRanges, mergeRanges, type Clip, type Edl, type Range, type TranscriptSegment } from "@/lib/edl";
import { AppError, conflict, notConfigured, notFound, validationError } from "@/lib/errors";
import { highlightsOutput } from "../ai/schemas";
import { audioChunkArgs, ffmpeg, probe } from "../media/ffmpeg";
import { ProviderError } from "../providers/llm";
import { driver } from "../storage";
import type { WorkspaceCtx } from "../tenancy";
import { effectiveConfig } from "./agent-config";
import { auditWs, checkUsage, recordUsage } from "./audit";
import { getTranscriber } from "./integrations";
import { callLlm } from "./llm-call";
import { getAsset, scratch } from "./media";

export type EditProject = typeof editProjects.$inferSelect;
export type Suggestion = typeof editSuggestions.$inferSelect;

/* ── transcription ────────────────────────────────────────────────────── */

export async function getTranscript(ws: Pick<WorkspaceCtx, "workspaceId">, assetId: string) {
  const [t] = await db.select().from(transcripts).where(and(eq(transcripts.assetId, assetId), eq(transcripts.workspaceId, ws.workspaceId))).limit(1);
  return t ?? null;
}

/** Idempotent: an existing transcript is returned rather than paid for twice. */
export async function transcribeAsset(ws: WorkspaceCtx, assetId: string, ctx: { jobId: string; signal: AbortSignal; progress: (p: number, note?: string) => Promise<void> }) {
  const existing = await getTranscript(ws, assetId);
  if (existing) return { transcriptId: existing.id, segmentCount: (existing.segments as unknown[]).length, reused: true };
  const asset = await getAsset(ws, assetId);
  if (asset.status !== "ready") throw new AppError("CONFLICT", "The recording is still processing; transcription will wait for it.");
  if (!asset.audioKey) throw validationError("This file has no audio track to transcribe.");
  const minutes = (asset.durationSeconds ?? 0) / 60;
  await checkUsage(ws, "transcription_minutes", minutes);
  const { config } = await effectiveConfig(ws);
  const stt = await getTranscriber(ws, config.models.transcription);

  const work = scratch("jobs", ctx.jobId);
  await mkdir(work, { recursive: true });
  try {
    const audio = await (await driver(asset.storageDriver)).toLocalFile(asset.audioKey, join(work, "speech.mp3"));
    const size = (await stat(audio)).size;
    const duration = (await probe(audio)).duration;
    // Split audio that exceeds the provider's request limit into time chunks.
    const chunks = Math.max(1, Math.ceil(size / (stt.maxBytes * 0.9)));
    const span = duration / chunks;
    const segments: TranscriptSegment[] = [];
    let language: string | null = null, words = false, speakers = false;
    for (let i = 0; i < chunks; i++) {
      await ctx.progress(5 + (i / chunks) * 90, `Transcribing part ${i + 1} of ${chunks}`);
      let file = audio;
      if (chunks > 1) {
        file = join(work, `chunk${i}.mp3`);
        await ffmpeg(audioChunkArgs(audio, file, i * span, span + 0.5), { signal: ctx.signal });
      }
      const r = await stt.transcribe(file, { language: config.models.transcription.language, diarization: config.models.transcription.diarization, signal: ctx.signal });
      const off = i * span;
      for (const s of r.segments) {
        if (chunks > 1 && i > 0 && s.start < 0.5) continue; // the 0.5s overlap was covered by the previous chunk
        segments.push({ ...s, id: `s${segments.length}`, start: s.start + off, end: s.end + off, words: s.words?.map((w) => ({ ...w, start: w.start + off, end: w.end + off })) });
      }
      language ??= r.language;
      words ||= r.hasWordTimings;
      speakers ||= r.hasSpeakers;
    }
    const [row] = await db.insert(transcripts).values({
      workspaceId: ws.workspaceId, assetId, provider: stt.provider, model: stt.model, language, segments, hasWordTimings: words, hasSpeakers: speakers, isMock: stt.isMock,
    }).onConflictDoNothing().returning();
    await recordUsage(ws.workspaceId, "transcription_minutes", minutes);
    const t = row ?? (await getTranscript(ws, assetId))!;
    return { transcriptId: t.id, segmentCount: segments.length, reused: !row };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/* ── proposals ────────────────────────────────────────────────────────── */

const norm = (s: string) => s.toLowerCase().replace(/\[mock\]\s*/g, "").replace(/[^\p{L}\p{N}\s']/gu, "").replace(/\s+/g, " ").trim();

export function similarity(a: string, b: string): number {
  const A = new Set(norm(a).split(" ").filter(Boolean)), B = new Set(norm(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

type Proposal = { type: string; start: number; end: number; text: string; reason: string; confidence: number | null; origin: "measured" | "ai" };

/** Measured proposals: pauses (FFmpeg), filler words and repeated takes (transcript timing). Pure. */
export function measuredProposals(opts: { duration: number; silences: Range[]; segments: TranscriptSegment[]; rules: AgentConfig["modules"]["editing"]["rules"] }): Proposal[] {
  const { rules } = opts;
  const out: Proposal[] = [];
  if (rules.removePauses) {
    for (const s of opts.silences) {
      if (s.end - s.start < rules.pauseThresholdSeconds) continue;
      const start = s.start + rules.pausePaddingSeconds, end = Math.min(opts.duration, s.end - rules.pausePaddingSeconds);
      if (end - start > 0.2) out.push({ type: "pause", start, end, text: "", reason: `Silence of ${(s.end - s.start).toFixed(1)}s (FFmpeg silencedetect)`, confidence: null, origin: "measured" });
    }
  }
  if (rules.removeFillerWords) {
    const single = new Set(rules.fillerWords.filter((f) => !f.includes(" ")).map((f) => f.toLowerCase()));
    const multi = rules.fillerWords.filter((f) => f.includes(" ")).map((f) => f.toLowerCase().split(" "));
    for (const seg of opts.segments) {
      const ws = seg.words ?? [];
      for (let i = 0; i < ws.length; i++) {
        const w = norm(ws[i].w);
        // "like" as a filler is ambiguous; only cut it when the transcript shows it between pauses (comma-delimited).
        if (single.has(w) && (w !== "like" || /,$/.test(ws[i].w))) {
          out.push({ type: "filler", start: ws[i].start, end: ws[i].end, text: ws[i].w, reason: `Filler word "${w}"`, confidence: null, origin: "measured" });
        }
        for (const m of multi) {
          if (m.every((part, k) => norm(ws[i + k]?.w ?? "") === part)) {
            out.push({ type: "filler", start: ws[i].start, end: ws[i + m.length - 1].end, text: m.join(" "), reason: `Filler phrase "${m.join(" ")}"`, confidence: null, origin: "measured" });
          }
        }
      }
    }
  }
  if (rules.removeRepeats) {
    for (let i = 0; i + 1 < opts.segments.length; i++) {
      const a = opts.segments[i], b = opts.segments[i + 1];
      if (norm(a.text).split(" ").length >= 3 && similarity(a.text, b.text) >= 0.8) {
        out.push({ type: "repeat", start: a.start, end: b.start, text: a.text, reason: "Repeated take — keeping the later one", confidence: Math.round(similarity(a.text, b.text) * 100) / 100, origin: "measured" });
      }
    }
  }
  return out;
}

const REMOVAL_TYPES = new Set(["pause", "filler", "repeat", "remove", "manual"]);

function defaultEdl(config: AgentConfig, assetId: string, presetId: string): Edl {
  const e = config.modules.editing;
  return edlSchema.parse({
    version: 1, sources: [{ id: "s1", assetId }], clips: [],
    output: { presetId, reframe: "fit" },
    audio: e.audio, transitions: e.transitions,
    captions: { enabled: e.captions.enabled, burnIn: e.captions.burnIn, style: e.captions.style, cues: [] },
    branding: { logoAssetId: null, logoPosition: e.branding.logoPosition, logoScale: e.branding.logoScale, logoOpacity: e.branding.logoOpacity, introAssetId: null, outroAssetId: null },
    lowerThirds: [],
  });
}

async function latestBrandAsset(ws: WorkspaceCtx, role: "brand" | "intro" | "outro") {
  const [a] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.workspaceId, ws.workspaceId), eq(mediaAssets.role, role), eq(mediaAssets.status, "ready"))).orderBy(desc(mediaAssets.createdAt)).limit(1);
  return a ?? null;
}

/**
 * Creates an edit project for a recording with a first-cut EDL.
 * review_first: measured cuts are applied to the draft (the creator restores what they want back).
 * assisted:     nothing is applied; every change waits for the creator.
 * automatic:    the configured `autoApplyTypes` are applied and the edit is pre-approved.
 */
export async function proposeEdit(ws: WorkspaceCtx, opts: { assetId: string; ideaId?: string | null; useLlm: boolean; sourceKey?: string; title?: string }) {
  if (opts.sourceKey) {
    const [ex] = await db.select().from(editProjects).where(and(eq(editProjects.sourceKey, opts.sourceKey), eq(editProjects.workspaceId, ws.workspaceId))).limit(1);
    if (ex) return { editProjectId: ex.id, suggestionCount: (await db.select({ id: editSuggestions.id }).from(editSuggestions).where(eq(editSuggestions.editProjectId, ex.id))).length, llmNote: null as string | null };
  }
  const asset = await getAsset(ws, opts.assetId);
  if (asset.role !== "source") throw validationError("Only source recordings can be edited.");
  if (asset.status !== "ready") throw new AppError("CONFLICT", "The recording is still processing.");
  if (opts.ideaId) {
    const [idea] = await db.select({ id: contentIdeas.id }).from(contentIdeas).where(and(eq(contentIdeas.id, opts.ideaId), eq(contentIdeas.workspaceId, ws.workspaceId))).limit(1);
    if (!idea) throw notFound("Idea not found.");
  }
  const { config } = await effectiveConfig(ws);
  if (!config.modules.editing.enabled) throw notConfigured("Editing is disabled in this workspace's agent configuration.");
  const mode = config.modules.editing.mode;
  const transcript = await getTranscript(ws, asset.id);
  const segments = (transcript?.segments ?? []) as TranscriptSegment[];
  const duration = asset.durationSeconds ?? 0;

  const proposals = measuredProposals({ duration, silences: (asset.silences ?? []) as Range[], segments, rules: config.modules.editing.rules });

  let llmNote: string | null = transcript ? null : "No transcript yet: only pause-based edits were proposed.";
  if (opts.useLlm && segments.length) {
    try {
      const known = new Map(segments.map((s) => [s.id, s]));
      const out = await callLlm(ws, config, {
        schemaName: "edit_highlights", schema: highlightsOutput, instructions: config.instructions.editing,
        task: "From this transcript, pick: the strongest opening hook, quotable moments, self-contained short-clip candidates (under the configured maximum length), topic changes, and segments that are clearly unusable (false starts, off-topic asides). Refer to segments only by their seg id. confidence is 0-1.",
        data: { maxShortSeconds: config.modules.editing.shorts.maxSeconds, segments: segments.slice(0, 1500).map((s) => ({ seg: s.id, t: Math.round(s.start), text: s.text })) },
      });
      for (const h of out.data.highlights) {
        const segs = h.segmentIds.map((id) => known.get(id)).filter((s): s is TranscriptSegment => Boolean(s));
        if (!segs.length) continue; // invented reference — dropped
        const start = Math.min(...segs.map((s) => s.start)), end = Math.max(...segs.map((s) => s.end));
        if (h.kind === "short_clip" && end - start > config.modules.editing.shorts.maxSeconds + 5) continue;
        proposals.push({ type: h.kind === "short_clip" ? "short_clip" : h.kind === "topic_change" ? "topic_change" : h.kind === "remove" ? "remove" : h.kind, start, end, text: segs.map((s) => s.text).join(" ").slice(0, 1000), reason: `${h.title}: ${h.reason}`.slice(0, 1000), confidence: Math.max(0, Math.min(1, h.confidence)), origin: "ai" });
      }
    } catch (e) {
      if (e instanceof AppError && (e.code === "NOT_CONFIGURED" || e.code === "PLAN_LIMIT_REACHED")) llmNote = `AI highlights skipped: ${e.message}`;
      else if (e instanceof ProviderError && !e.retryable) llmNote = `AI highlights skipped: ${e.message}`;
      else throw e;
    }
  }

  const applies = (p: Proposal) => REMOVAL_TYPES.has(p.type) && p.origin === "measured" &&
    (mode === "review_first" || (mode === "automatic" && (config.modules.editing.rules.autoApplyTypes as string[]).includes(p.type)));

  const edl = defaultEdl(config, asset.id, config.modules.editing.presets.final);
  edl.captions.cues = cuesFromTranscript("s1", segments, config.modules.editing.captions.style);
  const b = config.modules.editing.branding;
  if (b.useLogo) edl.branding.logoAssetId = (await latestBrandAsset(ws, "brand"))?.id ?? null;
  if (b.useIntro) edl.branding.introAssetId = (await latestBrandAsset(ws, "intro"))?.id ?? null;
  if (b.useOutro) edl.branding.outroAssetId = (await latestBrandAsset(ws, "outro"))?.id ?? null;
  edl.clips = rebuildClips(edl, "s1", duration, proposals.filter(applies), config.modules.editing.rules.minClipSeconds);

  const title = opts.title ?? asset.originalFilename.replace(/\.[^.]+$/, "");
  const editProjectId = await db.transaction(async (tx) => {
    const [ep] = await tx.insert(editProjects).values({
      workspaceId: ws.workspaceId, projectId: asset.projectId, ideaId: opts.ideaId ?? null, title, format: "long", editingMode: mode,
      status: mode === "automatic" ? "approved" : "in_review", edl, edlVersion: 1, sourceKey: opts.sourceKey ?? null, createdBy: ws.actorId,
      ...(mode === "automatic" ? { approvedVersion: 1, approvedAt: new Date() } : {}),
    }).returning();
    if (proposals.length) {
      await tx.insert(editSuggestions).values(proposals.map((p) => ({
        workspaceId: ws.workspaceId, editProjectId: ep.id, assetId: asset.id, type: p.type, start: p.start, end: p.end, text: p.text, reason: p.reason,
        confidence: p.confidence, origin: p.origin, status: applies(p) ? "accepted" : "proposed",
      })));
    }
    await tx.insert(edlRevisions).values({ workspaceId: ws.workspaceId, editProjectId: ep.id, version: 1, edl, note: `Agent first cut (${mode})`, createdBy: ws.actorId });
    if (opts.ideaId) await tx.update(contentIdeas).set({ status: "in_production" }).where(and(eq(contentIdeas.id, opts.ideaId), eq(contentIdeas.workspaceId, ws.workspaceId)));
    await auditWs(ws, { action: "edit.propose", entityType: "edit_project", entityId: ep.id, summary: `Proposed ${proposals.length} edit(s) for "${title}"` }, tx);
    return ep.id;
  });
  return { editProjectId, suggestionCount: proposals.length, llmNote };
}

/**
 * Replaces the clips of one source with its keep-ranges after `removals`,
 * leaving clips of other sources where they are.
 */
export function rebuildClips(edl: Edl, sourceId: string, duration: number, removals: Range[], minClip: number): Clip[] {
  const keep = keepRanges(duration, mergeRanges(removals), minClip);
  const firstIdx = edl.clips.findIndex((c) => c.sourceId === sourceId);
  const others = edl.clips.filter((c) => c.sourceId !== sourceId);
  const fresh = keep.map((r, i) => ({ id: `${sourceId}c${i + 1}`, sourceId, in: r.start, out: r.end }));
  const at = firstIdx === -1 ? others.length : Math.min(firstIdx, others.length);
  return [...others.slice(0, at), ...fresh, ...others.slice(at)];
}

/* ── review operations ────────────────────────────────────────────────── */

export async function getEdit(ws: Pick<WorkspaceCtx, "workspaceId">, id: string, conn: DbOrTx = db): Promise<EditProject> {
  const [row] = await conn.select().from(editProjects).where(and(eq(editProjects.id, id), eq(editProjects.workspaceId, ws.workspaceId))).limit(1);
  if (!row) throw notFound("Edit not found.");
  return row;
}

export async function listEdits(ws: WorkspaceCtx) {
  return db.select().from(editProjects).where(eq(editProjects.workspaceId, ws.workspaceId)).orderBy(desc(editProjects.updatedAt)).limit(200);
}

export async function suggestionsFor(ws: WorkspaceCtx, editId: string) {
  return db.select().from(editSuggestions).where(and(eq(editSuggestions.editProjectId, editId), eq(editSuggestions.workspaceId, ws.workspaceId))).orderBy(asc(editSuggestions.start));
}

/** Writes a new EDL version; any change after approval sends the edit back to review. */
async function saveEdl(ws: WorkspaceCtx, ep: EditProject, edl: Edl, note: string, conn: DbOrTx) {
  const parsed = edlSchema.parse(edl);
  const version = ep.edlVersion + 1;
  const backToReview = ep.status === "approved" || ep.status === "rendered";
  await conn.update(editProjects).set({ edl: parsed, edlVersion: version, updatedAt: new Date(), ...(backToReview && ep.editingMode !== "automatic" ? { status: "in_review" } : {}) })
    .where(and(eq(editProjects.id, ep.id), eq(editProjects.edlVersion, ep.edlVersion)));
  const [check] = await conn.select({ v: editProjects.edlVersion }).from(editProjects).where(eq(editProjects.id, ep.id));
  if (check.v !== version) throw conflict("Someone else changed this edit. Reload and try again.");
  await conn.insert(edlRevisions).values({ workspaceId: ws.workspaceId, editProjectId: ep.id, version, edl: parsed, note: note.slice(0, 300), createdBy: ws.actorId });
  return version;
}

async function rebuildFromSuggestions(ws: WorkspaceCtx, ep: EditProject, note: string, conn: DbOrTx) {
  const edl = edlSchema.parse(ep.edl);
  const { config } = await effectiveConfig(ws, conn);
  const sugg = await conn.select().from(editSuggestions).where(and(eq(editSuggestions.editProjectId, ep.id), eq(editSuggestions.status, "accepted")));
  for (const src of edl.sources) {
    const asset = await getAsset(ws, src.assetId);
    const removals = sugg.filter((s) => s.assetId === src.assetId && REMOVAL_TYPES.has(s.type));
    edl.clips = rebuildClips(edl, src.id, asset.durationSeconds ?? 0, removals, config.modules.editing.rules.minClipSeconds);
  }
  if (!edl.clips.length) throw validationError("That would remove the entire recording. Restore at least one segment.");
  return saveEdl(ws, ep, edl, note, conn);
}

export async function decideSuggestions(ws: WorkspaceCtx, editId: string, decisions: { id: string; status: "accepted" | "rejected" | "proposed" }[]) {
  return db.transaction(async (tx) => {
    const ep = await getEdit(ws, editId, tx);
    for (const d of decisions) {
      await tx.update(editSuggestions).set({ status: d.status }).where(and(eq(editSuggestions.id, d.id), eq(editSuggestions.editProjectId, ep.id), eq(editSuggestions.workspaceId, ws.workspaceId)));
    }
    return rebuildFromSuggestions(ws, ep, `${decisions.length} suggestion decision(s)`, tx);
  });
}

export async function adjustSuggestion(ws: WorkspaceCtx, editId: string, suggestionId: string, start: number, end: number) {
  if (!(end > start) || start < 0) throw validationError("End must be after start.");
  return db.transaction(async (tx) => {
    const ep = await getEdit(ws, editId, tx);
    await tx.update(editSuggestions).set({ start, end }).where(and(eq(editSuggestions.id, suggestionId), eq(editSuggestions.editProjectId, ep.id), eq(editSuggestions.workspaceId, ws.workspaceId)));
    return rebuildFromSuggestions(ws, ep, "Adjusted a cut's timestamps", tx);
  });
}

/** The creator marks a range of a source for removal (from the transcript or by timestamps). */
export async function addManualCut(ws: WorkspaceCtx, editId: string, input: { assetId: string; start: number; end: number; note?: string }) {
  if (!(input.end > input.start) || input.start < 0) throw validationError("End must be after start.");
  return db.transaction(async (tx) => {
    const ep = await getEdit(ws, editId, tx);
    const edl = edlSchema.parse(ep.edl);
    if (!edl.sources.some((s) => s.assetId === input.assetId)) throw validationError("That recording is not part of this edit.");
    await tx.insert(editSuggestions).values({ workspaceId: ws.workspaceId, editProjectId: ep.id, assetId: input.assetId, type: "manual", start: input.start, end: input.end, text: "", reason: input.note?.slice(0, 300) || "Removed by the creator", origin: "manual", status: "accepted" });
    return rebuildFromSuggestions(ws, ep, "Removed a segment", tx);
  });
}

export const edlPatch = z.object({
  output: edlSchema.shape.output.partial().optional(),
  audio: edlSchema.shape.audio.partial().optional(),
  transitions: edlSchema.shape.transitions.partial().optional(),
  captions: z.object({ enabled: z.boolean(), burnIn: z.boolean(), style: edlSchema.shape.captions.shape.style.partial() }).partial().optional(),
  branding: edlSchema.shape.branding.partial().optional(),
  lowerThirds: edlSchema.shape.lowerThirds.optional(),
  cueEdits: z.array(z.object({ id: z.string(), text: z.string().max(500) })).max(500).optional(),
  clipOrder: z.array(z.string()).max(2000).optional(),
  addSource: z.object({ assetId: z.uuid() }).optional(),
}).strict();

/** Settings, captions, branding, ordering and additional sources. */
export async function patchEdl(ws: WorkspaceCtx, editId: string, patch: z.infer<typeof edlPatch>) {
  const p = edlPatch.parse(patch);
  return db.transaction(async (tx) => {
    const ep = await getEdit(ws, editId, tx);
    const edl = edlSchema.parse(ep.edl);
    const { config } = await effectiveConfig(ws, tx);
    if (p.output) {
      Object.assign(edl.output, p.output);
      if (!config.renderPresets.some((r) => r.id === edl.output.presetId)) throw validationError("Unknown render preset.");
    }
    if (p.audio) Object.assign(edl.audio, p.audio);
    if (p.transitions) Object.assign(edl.transitions, p.transitions);
    if (p.captions) { const { style, ...rest } = p.captions; Object.assign(edl.captions, rest); if (style) Object.assign(edl.captions.style, style); }
    if (p.branding) {
      for (const k of ["logoAssetId", "introAssetId", "outroAssetId"] as const) {
        const id = p.branding[k];
        if (id) {
          const a = await getAsset(ws, id);
          const want = k === "logoAssetId" ? "brand" : k === "introAssetId" ? "intro" : "outro";
          if (a.role !== want || a.status !== "ready") throw validationError(`That asset is not a ready ${want} asset.`);
        }
      }
      Object.assign(edl.branding, p.branding);
    }
    if (p.lowerThirds) edl.lowerThirds = p.lowerThirds;
    if (p.cueEdits) for (const c of p.cueEdits) { const cue = edl.captions.cues.find((x) => x.id === c.id); if (cue) cue.text = c.text; }
    if (p.clipOrder) {
      const byId = new Map(edl.clips.map((c) => [c.id, c]));
      if (p.clipOrder.length !== edl.clips.length || !p.clipOrder.every((id) => byId.has(id))) throw validationError("Clip order must list every clip exactly once.");
      edl.clips = p.clipOrder.map((id) => byId.get(id)!);
    }
    if (p.addSource) {
      const a = await getAsset(ws, p.addSource.assetId);
      if (a.role !== "source" || a.status !== "ready") throw validationError("Only ready source recordings can be added.");
      if (edl.sources.some((s) => s.assetId === a.id)) throw validationError("That recording is already in this edit.");
      const sid = `s${edl.sources.length + 1}`;
      edl.sources.push({ id: sid, assetId: a.id });
      edl.clips.push({ id: `${sid}c1`, sourceId: sid, in: 0, out: a.durationSeconds ?? 0 });
      const t = await getTranscript(ws, a.id);
      if (t) edl.captions.cues.push(...cuesFromTranscript(sid, t.segments as TranscriptSegment[], edl.captions.style).map((c) => ({ ...c, id: `${sid}${c.id}` })));
    }
    return saveEdl(ws, ep, edl, "Edited settings", tx);
  });
}

export async function revisions(ws: WorkspaceCtx, editId: string) {
  return db.select({ version: edlRevisions.version, note: edlRevisions.note, createdAt: edlRevisions.createdAt }).from(edlRevisions)
    .where(and(eq(edlRevisions.editProjectId, editId), eq(edlRevisions.workspaceId, ws.workspaceId))).orderBy(desc(edlRevisions.version));
}

export async function restoreRevision(ws: WorkspaceCtx, editId: string, version: number) {
  return db.transaction(async (tx) => {
    const ep = await getEdit(ws, editId, tx);
    const [rev] = await tx.select().from(edlRevisions).where(and(eq(edlRevisions.editProjectId, ep.id), eq(edlRevisions.version, version))).limit(1);
    if (!rev) throw notFound("Revision not found.");
    return saveEdl(ws, ep, edlSchema.parse(rev.edl), `Restored version ${version}`, tx);
  });
}

/** Approves the CURRENT version. Later edits invalidate the approval automatically. */
export async function approveEdit(ws: WorkspaceCtx, editId: string, conn: DbOrTx = db) {
  const ep = await getEdit(ws, editId, conn);
  if (!(ep.edl as Edl).clips.length) throw validationError("The edit has no clips.");
  await conn.update(editProjects).set({ status: "approved", approvedVersion: ep.edlVersion, approvedBy: ws.actorId, approvedAt: new Date() }).where(eq(editProjects.id, ep.id));
  await auditWs(ws, { action: "edit.approve", entityType: "edit_project", entityId: ep.id, summary: `Approved edit "${ep.title}" (version ${ep.edlVersion})` }, conn);
  return ep.edlVersion;
}

export async function requestRevision(ws: WorkspaceCtx, editId: string, note: string) {
  const ep = await getEdit(ws, editId);
  await db.update(editProjects).set({ status: "in_review", approvedVersion: null }).where(eq(editProjects.id, ep.id));
  await auditWs(ws, { action: "edit.request_revision", entityType: "edit_project", entityId: ep.id, summary: `Requested revisions on "${ep.title}"`, metadata: { note: note.slice(0, 500) } });
}

/** A vertical/square short from a suggested clip, as its own edit project. */
export async function createShort(ws: WorkspaceCtx, editId: string, suggestionId: string) {
  const ep = await getEdit(ws, editId);
  const [s] = await db.select().from(editSuggestions).where(and(eq(editSuggestions.id, suggestionId), eq(editSuggestions.editProjectId, ep.id), eq(editSuggestions.workspaceId, ws.workspaceId))).limit(1);
  if (!s) throw notFound("Suggestion not found.");
  const { config } = await effectiveConfig(ws);
  const sh = config.modules.editing.shorts;
  const end = Math.min(s.end, s.start + sh.maxSeconds);
  const src = edlSchema.parse(ep.edl).sources.find((x) => x.assetId === s.assetId);
  if (!src) throw validationError("Source not found in this edit.");
  const edl = edlSchema.parse(ep.edl);
  edl.sources = [src];
  edl.clips = [{ id: `${src.id}c1`, sourceId: src.id, in: s.start, out: end }];
  edl.captions.cues = edl.captions.cues.filter((c) => c.sourceId === src.id);
  edl.captions.enabled = true;
  edl.captions.burnIn = true;
  edl.output = { presetId: sh.aspect === "1:1" ? (config.renderPresets.find((p) => p.width === p.height)?.id ?? config.modules.editing.presets.shorts) : config.modules.editing.presets.shorts, reframe: sh.reframe };
  edl.branding.introAssetId = null;
  edl.branding.outroAssetId = null;
  const [row] = await db.insert(editProjects).values({
    workspaceId: ws.workspaceId, projectId: ep.projectId, ideaId: ep.ideaId, parentEditId: ep.id, title: `${ep.title} — short`, format: "short",
    editingMode: ep.editingMode, status: "in_review", edl, edlVersion: 1, createdBy: ws.actorId,
  }).returning();
  await db.insert(edlRevisions).values({ workspaceId: ws.workspaceId, editProjectId: row.id, version: 1, edl, note: "Created from a suggested short clip", createdBy: ws.actorId });
  await auditWs(ws, { action: "edit.create_short", entityType: "edit_project", entityId: row.id, summary: `Created a short from "${ep.title}"` });
  return row;
}

export async function pendingApprovalFor(ws: WorkspaceCtx, subjectType: string, subjectId: string) {
  const [a] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.workspaceId, ws.workspaceId), eq(approvalRequests.subjectType, subjectType), eq(approvalRequests.subjectId, subjectId), inArray(approvalRequests.status, ["pending"]))).limit(1);
  return a ?? null;
}
