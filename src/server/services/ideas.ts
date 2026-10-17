import "server-only";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { calendarEntries, contentIdeas, ideaFeedback, videos } from "@/db/schema";
import { notConfigured, notFound, validationError } from "@/lib/errors";
import { ideasOutput } from "../ai/schemas";
import type { WorkspaceCtx } from "../tenancy";
import { effectiveConfig } from "./agent-config";
import { auditWs } from "./audit";
import { latestAnalysis, primaryChannel } from "./channel";
import { callLlm } from "./llm-call";
import { getProfile } from "./workspaces";

export type Idea = typeof contentIdeas.$inferSelect;
export type IdeaStatus = Idea["status"];

/**
 * Generates ideas from THIS workspace's channel data, profile, latest
 * analysis and explicit feedback only. Nothing from any other workspace is
 * read. `batchKey` makes the call idempotent when a workflow step is retried.
 */
export async function generateIdeas(ws: WorkspaceCtx, opts: { count?: number; focus?: string; batchKey?: string; replaces?: Idea }) {
  const batchId = opts.batchKey ?? crypto.randomUUID();
  if (opts.batchKey) {
    const existing = await db.select({ id: contentIdeas.id }).from(contentIdeas).where(and(eq(contentIdeas.workspaceId, ws.workspaceId), eq(contentIdeas.batchId, batchId)));
    if (existing.length) return { batchId, ideaCount: existing.length, reused: true };
  }

  const { config } = await effectiveConfig(ws);
  if (!config.modules.ideation.enabled) throw notConfigured("Ideation is disabled in this workspace's agent configuration.");
  const count = Math.min(30, Math.max(1, opts.count ?? config.modules.ideation.batchSize));
  const profile = await getProfile(ws);
  const channel = await primaryChannel(ws);
  const analysis = await latestAnalysis(ws);
  const vs = channel ? await db.select().from(videos).where(eq(videos.workspaceId, ws.workspaceId)).orderBy(desc(videos.publishedAt)).limit(config.modules.ideation.maxVideosInContext) : [];

  // Explicit feedback is the only personalisation signal, and it never leaves this workspace.
  const feedback = await db.select({ action: ideaFeedback.action, reason: ideaFeedback.reason, title: contentIdeas.title })
    .from(ideaFeedback).innerJoin(contentIdeas, eq(contentIdeas.id, ideaFeedback.ideaId))
    .where(eq(ideaFeedback.workspaceId, ws.workspaceId)).orderBy(desc(ideaFeedback.createdAt)).limit(40);
  const existingTitles = await db.select({ title: contentIdeas.title }).from(contentIdeas)
    .where(and(eq(contentIdeas.workspaceId, ws.workspaceId), inArray(contentIdeas.status, ["saved", "approved", "in_production", "published"]))).limit(60);

  const out = await callLlm(ws, config, {
    schemaName: "content_ideas", schema: ideasOutput,
    instructions: config.instructions.ideation,
    task: [
      `Generate exactly ${count} YouTube video ideas for this creator.`,
      opts.focus ? `Focus: ${opts.focus.slice(0, 500)}` : "",
      opts.replaces ? `Replace this rejected idea with a different one: "${opts.replaces.title}".` : "",
      config.modules.ideation.includeShortsIdeas ? "Include short-form repurposing opportunities where they genuinely fit." : "Do not propose Shorts.",
      "priorityScore is 0-100 with a reason; evidenceNotes must say which parts are measured facts and which are your hypotheses.",
      "supportingVideoIds must come only from the provided videos. Never claim an idea will go viral or rank.",
      "Respect topicsToAvoid and the creator's explicit feedback. Do not repeat existingIdeas.",
    ].filter(Boolean).join(" "),
    data: {
      creatorProfile: {
        niche: profile.niche, audience: profile.targetAudience, audienceProblems: profile.audienceProblems, interests: profile.audienceInterests,
        formats: profile.formats, preferredLengthMinutes: [profile.preferredLengthMin, profile.preferredLengthMax], tone: profile.tone, goals: profile.goals,
        topicsToAvoid: profile.avoidTopics, competitors: profile.competitorChannels, categories: profile.contentCategories, frequency: profile.publishingFrequency,
        savedPreferences: profile.savedPreferences,
      },
      analysis: analysis ? { measured: analysis.measured, hypotheses: analysis.hypotheses } : "No analysis yet.",
      videos: vs.map((v) => ({ youtubeId: v.youtubeVideoId, title: v.title, views: v.viewCount, durationSeconds: v.durationSeconds, publishedAt: v.publishedAt?.toISOString().slice(0, 10) })),
      creatorFeedback: feedback,
      existingIdeas: existingTitles.map((t) => t.title),
    },
  });

  const known = new Set(vs.map((v) => v.youtubeVideoId));
  const rows = out.data.ideas.slice(0, count).map((i) => ({
    workspaceId: ws.workspaceId, batchId, analysisId: analysis?.id ?? null,
    title: i.title.trim().slice(0, 200), concept: i.concept.slice(0, 4000), topic: i.topic.slice(0, 120),
    targetAudience: i.targetAudience.slice(0, 500), audienceNeed: i.audienceNeed.slice(0, 1000), fitReason: i.fitReason.slice(0, 2000),
    supportingVideoIds: i.supportingVideoIds.filter((id) => known.has(id)).slice(0, 10),
    hook: i.hook.slice(0, 1000), outline: i.outline.slice(0, 20).map((s) => s.slice(0, 500)), format: i.format.slice(0, 60),
    lengthMinutes: Number.isFinite(i.lengthMinutes) ? Math.max(0, Math.min(600, Math.round(i.lengthMinutes))) : null,
    keywords: i.keywords.slice(0, 20).map((k) => k.slice(0, 80)), shortsOpportunities: i.shortsOpportunities.slice(0, 10).map((s) => s.slice(0, 300)),
    priorityScore: Math.max(0, Math.min(100, Math.round(i.priorityScore))), priorityReason: i.priorityReason.slice(0, 1000), evidenceNotes: i.evidenceNotes.slice(0, 2000),
    provider: out.provider, model: out.model, isMock: out.isMock,
  })).filter((r) => r.title);
  if (!rows.length) throw validationError("The model returned no usable ideas.");
  await db.insert(contentIdeas).values(rows);
  await auditWs(ws, { action: "ideas.generate", entityType: "idea_batch", entityId: batchId, summary: `Generated ${rows.length} idea(s) with ${out.provider}` });
  return { batchId, ideaCount: rows.length, reused: false };
}

export const ideaFilters = z.object({
  status: z.enum(["proposed", "saved", "approved", "rejected", "in_production", "published", "archived"]).optional(),
  topic: z.string().max(120).optional(),
  format: z.string().max(60).optional(),
  audience: z.string().max(200).optional(),
  minPriority: z.coerce.number().int().min(0).max(100).optional(),
  batchId: z.uuid().optional(),
});

export async function listIdeas(ws: WorkspaceCtx, f: z.infer<typeof ideaFilters> = {}) {
  const conds = [eq(contentIdeas.workspaceId, ws.workspaceId)];
  if (f.status) conds.push(eq(contentIdeas.status, f.status));
  else conds.push(sql`${contentIdeas.status} not in ('archived','rejected')`);
  if (f.topic) conds.push(eq(contentIdeas.topic, f.topic));
  if (f.format) conds.push(eq(contentIdeas.format, f.format));
  if (f.audience) conds.push(sql`${contentIdeas.targetAudience} ilike ${"%" + f.audience + "%"}`);
  if (f.minPriority) conds.push(gte(contentIdeas.priorityScore, f.minPriority));
  if (f.batchId) conds.push(eq(contentIdeas.batchId, f.batchId));
  return db.select().from(contentIdeas).where(and(...conds)).orderBy(desc(contentIdeas.priorityScore), desc(contentIdeas.createdAt)).limit(300);
}

export async function ideaFacets(ws: WorkspaceCtx) {
  const rows = await db.selectDistinct({ topic: contentIdeas.topic, format: contentIdeas.format }).from(contentIdeas).where(eq(contentIdeas.workspaceId, ws.workspaceId));
  return { topics: [...new Set(rows.map((r) => r.topic).filter(Boolean))].sort(), formats: [...new Set(rows.map((r) => r.format).filter(Boolean))].sort() };
}

export async function getIdea(ws: WorkspaceCtx, id: string): Promise<Idea> {
  const [row] = await db.select().from(contentIdeas).where(and(eq(contentIdeas.id, id), eq(contentIdeas.workspaceId, ws.workspaceId))).limit(1);
  if (!row) throw notFound("Idea not found.");
  return row;
}

export const ideaEdit = z.object({
  title: z.string().trim().min(1).max(200), concept: z.string().max(4000), hook: z.string().max(1000), topic: z.string().max(120),
  targetAudience: z.string().max(500), format: z.string().max(60), lengthMinutes: z.number().int().min(0).max(600).nullable(),
  outline: z.array(z.string().max(500)).max(20), keywords: z.array(z.string().max(80)).max(20), priorityScore: z.number().int().min(0).max(100),
}).partial();

export async function editIdea(ws: WorkspaceCtx, id: string, patch: z.infer<typeof ideaEdit>) {
  await getIdea(ws, id);
  const data = ideaEdit.parse(patch);
  await db.update(contentIdeas).set({ ...data, updatedAt: new Date() }).where(and(eq(contentIdeas.id, id), eq(contentIdeas.workspaceId, ws.workspaceId)));
  await db.insert(ideaFeedback).values({ workspaceId: ws.workspaceId, ideaId: id, userId: ws.actorId, action: "edit", reason: "" });
}

export async function setIdeaStatus(ws: WorkspaceCtx, id: string, status: IdeaStatus, reason = "") {
  const idea = await getIdea(ws, id);
  await db.update(contentIdeas).set({ status, updatedAt: new Date() }).where(and(eq(contentIdeas.id, id), eq(contentIdeas.workspaceId, ws.workspaceId)));
  if (["approved", "rejected", "saved"].includes(status)) {
    await db.insert(ideaFeedback).values({ workspaceId: ws.workspaceId, ideaId: id, userId: ws.actorId, action: status === "saved" ? "save" : status === "approved" ? "approve" : "reject", reason: reason.slice(0, 500) });
  }
  if (status === "rejected" || status === "archived") await db.delete(calendarEntries).where(and(eq(calendarEntries.ideaId, id), eq(calendarEntries.workspaceId, ws.workspaceId)));
  await auditWs(ws, { action: `idea.${status}`, entityType: "idea", entityId: id, summary: `${status[0].toUpperCase()}${status.slice(1)} idea "${idea.title}"` });
}

/** Rejects an idea with a reason and asks the model for a replacement informed by that feedback. */
export async function regenerateIdea(ws: WorkspaceCtx, id: string, reason: string) {
  const idea = await getIdea(ws, id);
  await setIdeaStatus(ws, id, "rejected", reason || "Regenerated");
  return generateIdeas(ws, { count: 1, replaces: idea, focus: reason ? `Avoid: ${reason}` : undefined });
}

/* ── calendar ─────────────────────────────────────────────────────────── */

export async function scheduleIdea(ws: WorkspaceCtx, ideaId: string, date: string, notes = "") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validationError("Use a date in YYYY-MM-DD format.");
  const idea = await getIdea(ws, ideaId);
  if (idea.status !== "approved" && idea.status !== "in_production") throw validationError("Only approved ideas can be scheduled.");
  await db.insert(calendarEntries).values({ workspaceId: ws.workspaceId, ideaId, publishDate: date, notes: notes.slice(0, 500) })
    .onConflictDoUpdate({ target: calendarEntries.ideaId, set: { publishDate: date, notes: notes.slice(0, 500) } });
  await auditWs(ws, { action: "calendar.schedule", entityType: "idea", entityId: ideaId, summary: `Scheduled "${idea.title}" for ${date}` });
}

export async function unscheduleIdea(ws: WorkspaceCtx, ideaId: string) {
  await db.delete(calendarEntries).where(and(eq(calendarEntries.ideaId, ideaId), eq(calendarEntries.workspaceId, ws.workspaceId)));
}

export async function calendarMonth(ws: WorkspaceCtx, month: string) {
  const start = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return db.select({ entry: calendarEntries, idea: contentIdeas }).from(calendarEntries).innerJoin(contentIdeas, eq(contentIdeas.id, calendarEntries.ideaId))
    .where(and(eq(calendarEntries.workspaceId, ws.workspaceId), gte(calendarEntries.publishDate, start), lte(calendarEntries.publishDate, end))).orderBy(asc(calendarEntries.publishDate));
}
