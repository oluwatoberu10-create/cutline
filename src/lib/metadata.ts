import { z } from "zod";

/**
 * Publishing metadata, constrained to what the YouTube Data API accepts:
 * title ≤ 100 chars and no "<" or ">", description ≤ 5000 bytes, tags ≤ 500
 * characters in total, chapters starting at 0:00 with at least three entries
 * of ≥ 10 seconds.
 */

export const chapterSchema = z.object({ start: z.number().min(0), title: z.string().min(1).max(100) }).strict();

export const publishMetadataSchema = z.object({
  title: z.string().trim().min(1).max(100).refine((s) => !/[<>]/.test(s), "Titles cannot contain < or >."),
  description: z.string().max(5000).refine((s) => Buffer.byteLength(s, "utf8") <= 5000, "Description exceeds 5000 bytes.").refine((s) => !/[<>]/.test(s), "Descriptions cannot contain < or >."),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]{1,60}$/u, "Hashtags are # followed by letters, numbers or _.")).max(15).default([]),
  chapters: z.array(chapterSchema).max(100).default([]),
  categoryId: z.string().regex(/^\d{1,3}$/).default("22"),
  privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
  /** ISO datetime; YouTube requires privacyStatus "private" when publishAt is set. */
  publishAt: z.iso.datetime({ offset: true }).nullable().default(null),
  madeForKids: z.boolean().default(false),
  playlistId: z.string().max(64).nullable().default(null),
  pinnedComment: z.string().max(10_000).default(""),
  language: z.string().max(10).default("en"),
}).strict();

export type PublishMetadata = z.infer<typeof publishMetadataSchema>;

export const metadataSuggestionsSchema = z.object({
  titleOptions: z.array(z.string().max(100)).max(10).default([]),
  thumbnailConcepts: z.array(z.object({ concept: z.string().max(400), textOverlay: z.string().max(60) }).strict()).max(6).default([]),
  playlistSuggestions: z.array(z.object({ playlistId: z.string(), title: z.string(), reason: z.string().max(300) }).strict()).max(5).default([]),
  cta: z.string().max(500).default(""),
  notes: z.array(z.string().max(300)).max(10).default([]),
}).strict();

export type MetadataSuggestions = z.infer<typeof metadataSuggestionsSchema>;

export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Applies YouTube's chapter rules; returns the cleaned list or [] when they cannot be met. */
export function normalizeChapters(chapters: { start: number; title: string }[], durationSeconds: number): { chapters: { start: number; title: string }[]; problem?: string } {
  const sorted = chapters.filter((c) => c.start >= 0 && c.start < durationSeconds && c.title.trim())
    .map((c) => ({ start: Math.floor(c.start), title: c.title.trim().slice(0, 100) }))
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return { chapters: [] };
  sorted[0].start = 0;
  const out: { start: number; title: string }[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && c.start - prev.start < 10) continue;
    out.push(c);
  }
  if (out.length && durationSeconds - out[out.length - 1].start < 10) out.pop();
  if (out.length < 3) return { chapters: [], problem: "YouTube needs at least three chapters of 10 seconds or more; chapters were left out." };
  return { chapters: out };
}

export function chaptersBlock(chapters: { start: number; title: string }[]): string {
  return chapters.map((c) => `${formatTimestamp(c.start)} ${c.title}`).join("\n");
}

/** Tags are limited to 500 characters in total (YouTube counts quoted multi-word tags with quotes). */
export function fitTags(tags: string[], max: number): string[] {
  const out: string[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().replace(/[<>,]/g, "");
    if (!t || seen.has(t.toLowerCase())) continue;
    const cost = t.length + (t.includes(" ") ? 2 : 0) + (out.length ? 1 : 0);
    if (total + cost > 500 || out.length >= max) break;
    out.push(t);
    seen.add(t.toLowerCase());
    total += cost;
  }
  return out;
}

export function renderDescription(template: string, parts: { summary: string; chapters: string; cta: string; hashtags: string[] }): string {
  return template
    .replace("{{summary}}", parts.summary.trim())
    .replace("{{chapters}}", parts.chapters.trim())
    .replace("{{cta}}", parts.cta.trim())
    .replace("{{hashtags}}", parts.hashtags.join(" "))
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[<>]/g, "")
    .trim();
}
