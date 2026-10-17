import { z } from "zod";

/**
 * The workflow node registry.
 *
 * A workflow (in a blueprint or anywhere else) can only reference node types
 * listed here. Each type declares its config schema, what it produces, which
 * logical integrations it needs and whether it has external side effects.
 * Imported blueprints are validated against this list — an unknown type is
 * rejected and nothing in a blueprint is ever executed as code.
 *
 * The executors live in src/server/workflow/executors.ts; this file is pure
 * metadata so it can run in the browser and in validation scripts.
 */

export type IntegrationKind = "youtube" | "llm" | "transcription" | "storage";

/** `{ "$from": "input.assetId" }` — a value resolved at run time from run input or an earlier step's output. */
export const fromRef = z.object({ $from: z.string().regex(/^(input|steps\.[a-z][a-z0-9_]*\.output)(\.[A-Za-z0-9_]+)*$/) }).strict();
const refOr = <T extends z.ZodType>(t: T) => z.union([t, fromRef]);

export type NodeSpec = {
  type: string;
  label: string;
  description: string;
  category: "channel" | "ideation" | "media" | "editing" | "publishing" | "control";
  config: z.ZodType;
  /** Keys this node puts in its output, for documentation and $from validation. */
  outputs: string[];
  requires: IntegrationKind[];
  /** Calls an external service in a way that changes state (uploads, publishes). */
  sideEffect: boolean;
  /** Introduced in this schema version. */
  since: string;
  deprecated?: { since: string; replacedBy?: string; note: string };
};

const NODES: NodeSpec[] = [
  {
    type: "channel.sync", label: "Sync channel", category: "channel",
    description: "Refresh channel, video, playlist and (when authorised) analytics data from the YouTube APIs.",
    config: z.object({ maxVideos: z.number().int().min(1).max(500).default(200) }).strict(),
    outputs: ["channelId", "videosSynced", "analyticsAvailable"], requires: ["youtube"], sideEffect: false, since: "1.0.0",
  },
  {
    type: "channel.analyze", label: "Analyse channel", category: "channel",
    description: "Compute measured findings from synced data and, when an LLM is configured, add labelled hypotheses.",
    config: z.object({ useLlm: z.boolean().default(true) }).strict(),
    outputs: ["analysisId", "hasHypotheses"], requires: [], sideEffect: false, since: "1.0.0",
  },
  {
    type: "ideas.generate", label: "Generate content ideas", category: "ideation",
    description: "Generate a batch of ideas grounded in channel data, the creator profile and saved feedback.",
    config: z.object({ count: z.number().int().min(1).max(30).optional(), focus: z.string().max(500).optional() }).strict(),
    outputs: ["batchId", "ideaCount"], requires: ["llm"], sideEffect: false, since: "1.0.0",
  },
  {
    type: "approval.gate", label: "Wait for approval", category: "control",
    description: "Pause the run until an authorised workspace member approves or rejects.",
    config: z.object({
      kind: z.enum(["ideas", "edit", "render", "publish", "custom"]),
      title: z.string().min(1).max(200),
      subject: refOr(z.string()).optional(),
    }).strict(),
    outputs: ["decision", "approvalId"], requires: [], sideEffect: false, since: "1.0.0",
  },
  {
    type: "media.transcribe", label: "Transcribe footage", category: "media",
    description: "Transcribe an uploaded recording with the configured speech-to-text provider.",
    config: z.object({ asset: refOr(z.string()) }).strict(),
    outputs: ["transcriptId", "segmentCount"], requires: ["transcription"], sideEffect: false, since: "1.0.0",
  },
  {
    type: "edit.propose", label: "Propose edits", category: "editing",
    description: "Build a first-cut edit-decision list from measured pauses, filler words, repeats and (optionally) AI-picked highlights.",
    config: z.object({ asset: refOr(z.string()), idea: refOr(z.string()).optional(), useLlm: z.boolean().default(true) }).strict(),
    outputs: ["editProjectId", "suggestionCount"], requires: [], sideEffect: false, since: "1.0.0",
  },
  {
    type: "render.draft", label: "Render draft", category: "editing",
    description: "Render a low-resolution review copy of the current edit with FFmpeg.",
    config: z.object({ edit: refOr(z.string()) }).strict(),
    outputs: ["renderJobId", "outputAssetId"], requires: ["storage"], sideEffect: false, since: "1.0.0",
  },
  {
    type: "render.final", label: "Render final", category: "editing",
    description: "Render the approved edit at the final preset. Fails if the edit has not been approved.",
    config: z.object({ edit: refOr(z.string()) }).strict(),
    outputs: ["renderJobId", "outputAssetId"], requires: ["storage"], sideEffect: false, since: "1.0.0",
  },
  {
    type: "metadata.generate", label: "Generate metadata", category: "publishing",
    description: "Draft titles, description, tags, chapters, captions and a pinned comment for a rendered video.",
    config: z.object({ edit: refOr(z.string()), render: refOr(z.string()) }).strict(),
    outputs: ["publishingJobId"], requires: ["llm"], sideEffect: false, since: "1.0.0",
  },
  {
    type: "publish.upload", label: "Upload to YouTube", category: "publishing",
    description: "Upload (and optionally schedule) an approved publishing job through the YouTube Data API.",
    config: z.object({ publishingJob: refOr(z.string()) }).strict(),
    outputs: ["youtubeVideoId", "status"], requires: ["youtube"], sideEffect: true, since: "1.0.0",
  },
  {
    type: "publish.track", label: "Track processing", category: "publishing",
    description: "Poll YouTube for processing/publication status of an uploaded video.",
    config: z.object({ publishingJob: refOr(z.string()) }).strict(),
    outputs: ["status"], requires: ["youtube"], sideEffect: false, since: "1.0.0",
  },
];

export const NODE_REGISTRY: ReadonlyMap<string, NodeSpec> = new Map(NODES.map((n) => [n.type, n]));
export const NODE_TYPES = NODES.map((n) => n.type);

export function nodeSpec(type: string): NodeSpec | undefined {
  return NODE_REGISTRY.get(type);
}
