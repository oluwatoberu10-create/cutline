import "server-only";
import type { TranscriptSegment } from "@/lib/edl";
import type { HighlightsOutput, HypothesesOutput, IdeasOutput, MetadataOutput } from "../ai/schemas";
import { probe } from "../media/ffmpeg";
import type { LlmRequest } from "./llm";

/**
 * Deterministic providers for automated tests. Enabled only when
 * CUTLINE_ENABLE_MOCK_PROVIDERS=true outside production; every row they
 * produce is stored with isMock=true and badged "Mock" in the UI.
 * Outputs are derived from the ids present in the prompt, so grounding and
 * validation code paths are exercised exactly as with a real model.
 */

const ids = (prompt: string, re: RegExp) => [...new Set([...prompt.matchAll(re)].map((m) => m[1]))];

/** The most recent prompt the mock received — lets tests assert what data reached the model. */
export const mockPromptLog: { system: string; prompt: string; schemaName: string }[] = [];

export function mockLlmResponder(req: LlmRequest<unknown>): unknown {
  mockPromptLog.push({ system: req.system, prompt: req.prompt, schemaName: req.schemaName });
  if (mockPromptLog.length > 50) mockPromptLog.shift();
  const videoIds = ids(req.prompt, /"youtubeId":"([^"]+)"/g);
  const segIds = ids(req.prompt, /"seg":"([^"]+)"/g);
  const playlistIds = ids(req.prompt, /"playlistId":"([^"]+)"/g);

  switch (req.schemaName) {
    case "channel_hypotheses":
      return {
        summary: "[mock] The channel's most-viewed uploads cluster around one subject.",
        hypotheses: [
          { kind: "resonating_topic", statement: "[mock] The top video's subject outperforms the channel median.", evidence: "Ranked first by views in the provided list.", videoIds: videoIds.slice(0, 1), confidence: "medium" },
          { kind: "content_gap", statement: "[mock] No beginner-level explainer exists.", evidence: "No title mentions beginners.", videoIds: [], confidence: "low" },
          { kind: "follow_up", statement: "[mock] Invented reference should be dropped.", evidence: "Test of grounding.", videoIds: ["NOT_A_REAL_VIDEO"], confidence: "low" },
        ],
      } satisfies HypothesesOutput;
    case "content_ideas": {
      const n = Number(/Generate exactly (\d+) ideas/.exec(req.prompt)?.[1] ?? 3);
      return {
        ideas: Array.from({ length: n }, (_, i) => ({
          title: `[mock] Idea ${i + 1}: follow-up to a top video`,
          concept: "A deeper follow-up answering the most common question.",
          topic: i % 2 ? "Tutorials" : "Explainers",
          targetAudience: "Beginners", audienceNeed: "Understand the basics quickly",
          fitReason: "Extends a proven topic on this channel.",
          supportingVideoIds: [...videoIds.slice(0, 1), "INVENTED_ID"],
          hook: "Most people get this wrong in the first minute.",
          outline: ["Hook", "Problem", "Walkthrough", "Recap"],
          format: "tutorial", lengthMinutes: 10, keywords: ["beginner guide"], shortsOpportunities: ["60s tip from the walkthrough"],
          priorityScore: 80 - i * 5, priorityReason: "Builds on the best-performing upload.", evidenceNotes: "Hypothesis based on relative views.",
        })),
      } satisfies IdeasOutput;
    }
    case "edit_highlights":
      return {
        highlights: [
          { kind: "hook", segmentIds: segIds.slice(0, 1), title: "[mock] Opening line", reason: "First statement of the topic.", confidence: 0.7 },
          { kind: "short_clip", segmentIds: segIds.slice(1, 3), title: "[mock] Short candidate", reason: "Self-contained explanation.", confidence: 0.6 },
          { kind: "quote", segmentIds: ["seg_does_not_exist"], title: "invented", reason: "should be dropped", confidence: 0.5 },
        ],
      } satisfies HighlightsOutput;
    case "publish_metadata":
      return {
        titleOptions: ["[mock] How to Get Started (Step by Step)", "[mock] The Beginner's Guide", "[mock] Avoid These Mistakes"],
        summary: "[mock] A practical walkthrough of the topic covered in this recording.",
        chapters: segIds.slice(0, 4).map((s, i) => ({ segmentId: s, title: `Part ${i + 1}` })),
        tags: ["beginner guide", "tutorial", "how to"],
        hashtags: ["#tutorial", "#beginners", "not a hashtag"],
        pinnedComment: "[mock] What should the next video cover?",
        cta: "Subscribe for the next part.",
        thumbnailConcepts: [{ concept: "Creator pointing at the key step", textOverlay: "DO THIS FIRST" }],
        playlistSuggestions: [...playlistIds.slice(0, 1).map((p) => ({ playlistId: p, reason: "Same series." })), { playlistId: "PL_INVENTED", reason: "invented" }],
        notes: [],
      } satisfies MetadataOutput;
    default:
      throw new Error(`Mock LLM has no response for schema "${req.schemaName}".`);
  }
}

/** Placeholder speech every 4 seconds, with filler words and one repeated sentence to exercise the editor. */
export async function mockTranscriptScript(audioPath: string): Promise<TranscriptSegment[]> {
  const duration = (await probe(audioPath)).duration;
  const segs: TranscriptSegment[] = [];
  const lines = ["Um, welcome back to the channel.", "Today we cover the basics.", "Today we cover the basics.", "Uh, first, set up the tools.", "Then follow these three steps.", "That is the key idea to remember."];
  for (let t = 0, i = 0; t + 2 < duration; t += 4, i++) {
    const text = lines[i % lines.length];
    const words = text.split(" ");
    const step = 2.5 / words.length;
    segs.push({ id: `s${i}`, start: t, end: t + 2.5, text: `[mock] ${text}`, words: words.map((w, k) => ({ w, start: t + k * step, end: t + (k + 1) * step })) });
  }
  return segs;
}
