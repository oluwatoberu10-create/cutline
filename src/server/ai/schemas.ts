import { z } from "zod";

/**
 * Shapes requested from language models. Kept simple (strings, numbers,
 * arrays, enums) so every provider's structured-output mode can express them.
 * Anything that points at real data — video ids, transcript segment ids,
 * playlist ids — is checked against the database afterwards and dropped if
 * the model invented it.
 */

export const hypothesesOutput = z.object({
  summary: z.string(),
  hypotheses: z.array(z.object({
    kind: z.enum(["resonating_topic", "content_gap", "overused_topic", "follow_up", "shorts_opportunity", "audience_question", "series", "goal_gap"]),
    statement: z.string(),
    evidence: z.string(),
    videoIds: z.array(z.string()),
    confidence: z.enum(["low", "medium", "high"]),
  })),
});
export type HypothesesOutput = z.infer<typeof hypothesesOutput>;

export const ideasOutput = z.object({
  ideas: z.array(z.object({
    title: z.string(),
    concept: z.string(),
    topic: z.string(),
    targetAudience: z.string(),
    audienceNeed: z.string(),
    fitReason: z.string(),
    supportingVideoIds: z.array(z.string()),
    hook: z.string(),
    outline: z.array(z.string()),
    format: z.string(),
    lengthMinutes: z.number(),
    keywords: z.array(z.string()),
    shortsOpportunities: z.array(z.string()),
    priorityScore: z.number(),
    priorityReason: z.string(),
    evidenceNotes: z.string(),
  })),
});
export type IdeasOutput = z.infer<typeof ideasOutput>;

export const highlightsOutput = z.object({
  highlights: z.array(z.object({
    kind: z.enum(["hook", "quote", "short_clip", "topic_change", "remove"]),
    segmentIds: z.array(z.string()),
    title: z.string(),
    reason: z.string(),
    confidence: z.number(),
  })),
});
export type HighlightsOutput = z.infer<typeof highlightsOutput>;

export const metadataOutput = z.object({
  titleOptions: z.array(z.string()),
  summary: z.string(),
  chapters: z.array(z.object({ segmentId: z.string(), title: z.string() })),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
  pinnedComment: z.string(),
  cta: z.string(),
  thumbnailConcepts: z.array(z.object({ concept: z.string(), textOverlay: z.string() })),
  playlistSuggestions: z.array(z.object({ playlistId: z.string(), reason: z.string() })),
  notes: z.array(z.string()),
});
export type MetadataOutput = z.infer<typeof metadataOutput>;
