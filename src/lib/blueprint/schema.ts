import { z } from "zod";
import { workflowSchema } from "../workflow/definition";

/**
 * The Cutline agent blueprint format (schema 1.x).
 *
 * A blueprint is reusable agent LOGIC: instructions, workflows, editing rules,
 * render presets, SEO rules, approval gates, and the *names* of the
 * integrations and environment variables it needs. It never contains client
 * data — no account ids, tokens, footage, transcripts, analytics, storage
 * paths or signed URLs. Integrations are referenced by logical name
 * (`youtube_connection`, `llm_provider` …) and each deployment binds those
 * names to the client's own connections.
 *
 * Every object is `.strict()`: unknown keys are rejected, which is also what
 * stops private fields being smuggled into an export.
 */

export const BLUEPRINT_FORMAT = "cutline.blueprint";
export const SCHEMA_VERSION = "1.0.0";
export const APP_VERSION = "1.0.0";
/** Oldest blueprint schema this build can import. */
export const MIN_SUPPORTED_SCHEMA = "1.0.0";

export const semver = z.string().regex(/^\d+\.\d+\.\d+$/, "Use MAJOR.MINOR.PATCH, e.g. 1.2.0");

const shortText = (max = 200) => z.string().max(max);
const longText = (max = 8000) => z.string().max(max);

/* ── integrations, env and capabilities ───────────────────────────────── */

export const INTEGRATION_KINDS = ["youtube", "llm", "transcription", "storage"] as const;
export const YOUTUBE_SCOPES = ["youtube.readonly", "yt-analytics.readonly", "youtube.upload", "youtube.force-ssl"] as const;
export const CAPABILITIES = [
  "ffmpeg", "ffprobe", "llm.structured_json", "transcription.timestamps", "transcription.word_timestamps",
  "transcription.diarization", "youtube.data", "youtube.analytics", "youtube.upload", "youtube.captions",
  "storage.signed_urls",
] as const;

export const integrationRefSchema = z.object({
  ref: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  kind: z.enum(INTEGRATION_KINDS),
  required: z.boolean(),
  purpose: shortText(300),
  /** YouTube only: OAuth scopes the deployment must grant. */
  scopes: z.array(z.enum(YOUTUBE_SCOPES)).max(4).optional(),
}).strict();

/** A secret is only ever named, never valued: `{ "$secret": "OPENAI_API_KEY" }`. */
export const envVarSchema = z.object({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  required: z.boolean(),
  secret: z.boolean(),
  description: shortText(300),
  /** Only for non-secret variables. Must be a placeholder, never a real value. */
  example: shortText(200).optional(),
}).strict().refine((v) => !(v.secret && v.example), { message: "Secret variables may not carry an example value." });

/* ── models ───────────────────────────────────────────────────────────── */

export const LLM_PROVIDERS = ["anthropic", "openai"] as const;
export const TRANSCRIPTION_PROVIDERS = ["openai", "deepgram"] as const;

const modelPrefsSchema = z.object({
  ref: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).default("llm_provider"),
  /** Preference order; the first one the client has configured is used. */
  preferences: z.array(z.object({ provider: z.enum(LLM_PROVIDERS), model: shortText(80) }).strict()).min(1).max(5),
  effort: z.enum(["low", "medium", "high"]).default("medium"),
  maxOutputTokens: z.number().int().min(1000).max(64000).default(16000),
}).strict();

const transcriptionPrefsSchema = z.object({
  ref: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/).default("transcription_provider"),
  preferences: z.array(z.object({ provider: z.enum(TRANSCRIPTION_PROVIDERS), model: shortText(80) }).strict()).min(1).max(5),
  language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/).optional(),
  diarization: z.boolean().default(false),
}).strict();

/* ── editing, rendering, captions ─────────────────────────────────────── */

export const renderPresetSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,40}$/),
  label: shortText(80),
  width: z.number().int().min(144).max(3840),
  height: z.number().int().min(144).max(3840),
  fps: z.number().min(12).max(60),
  container: z.enum(["mp4", "webm"]),
  crf: z.number().int().min(14).max(40).default(21),
  speed: z.enum(["ultrafast", "veryfast", "fast", "medium", "slow"]).default("veryfast"),
  audioBitrateK: z.number().int().min(64).max(320).default(160),
}).strict().refine((p) => p.width % 2 === 0 && p.height % 2 === 0, { message: "Width and height must be even numbers." });

export const captionStyleSchema = z.object({
  font: shortText(60).default("Arial"),
  fontSize: z.number().int().min(10).max(120).default(44),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  outline: z.number().min(0).max(8).default(3),
  position: z.enum(["bottom", "middle", "top"]).default("bottom"),
  maxCharsPerLine: z.number().int().min(12).max(80).default(42),
  maxLines: z.number().int().min(1).max(3).default(2),
}).strict();

const editingSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(["assisted", "review_first", "automatic"]).default("review_first"),
  rules: z.object({
    removePauses: z.boolean().default(true),
    /** Pauses longer than this (seconds) are proposed for removal. */
    pauseThresholdSeconds: z.number().min(0.3).max(10).default(0.9),
    /** Silence kept either side of a cut so speech is not clipped. */
    pausePaddingSeconds: z.number().min(0).max(1).default(0.15),
    silenceNoiseDb: z.number().min(-70).max(-15).default(-35),
    removeFillerWords: z.boolean().default(true),
    fillerWords: z.array(shortText(30)).max(40).default(["um", "uh", "erm", "ah", "like", "you know"]),
    removeRepeats: z.boolean().default(true),
    minClipSeconds: z.number().min(0.2).max(10).default(0.6),
    /** Automatic mode applies only these suggestion types without review. */
    autoApplyTypes: z.array(z.enum(["pause", "filler", "repeat"])).default(["pause"]),
  }).strict().prefault({}),
  audio: z.object({
    normalize: z.boolean().default(true),
    targetLufs: z.number().min(-30).max(-9).default(-14),
    noiseReduction: z.enum(["off", "light", "medium", "strong"]).default("off"),
  }).strict().prefault({}),
  transitions: z.object({
    type: z.enum(["none", "fade"]).default("none"),
    durationMs: z.number().int().min(0).max(2000).default(200),
  }).strict().prefault({}),
  captions: z.object({
    enabled: z.boolean().default(true),
    burnIn: z.boolean().default(false),
    style: captionStyleSchema.prefault({}),
  }).strict().prefault({}),
  branding: z.object({
    /** Logical brand-asset slots. Each client uploads their own files into these slots. */
    useLogo: z.boolean().default(false),
    logoPosition: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("top-right"),
    logoScale: z.number().min(0.03).max(0.4).default(0.1),
    logoOpacity: z.number().min(0.1).max(1).default(0.85),
    useIntro: z.boolean().default(false),
    useOutro: z.boolean().default(false),
    lowerThirds: z.boolean().default(false),
  }).strict().prefault({}),
  shorts: z.object({
    enabled: z.boolean().default(true),
    maxSeconds: z.number().int().min(10).max(180).default(58),
    count: z.number().int().min(0).max(10).default(3),
    aspect: z.enum(["9:16", "1:1"]).default("9:16"),
    reframe: z.enum(["center_crop", "blur_pad"]).default("center_crop"),
  }).strict().prefault({}),
  presets: z.object({ draft: z.string().default("draft-540p"), final: z.string().default("final-1080p"), shorts: z.string().default("shorts-1080x1920") }).strict().prefault({}),
}).strict();

/* ── ideation, SEO, publishing ────────────────────────────────────────── */

const ideationSchema = z.object({
  enabled: z.boolean().default(true),
  batchSize: z.number().int().min(1).max(30).default(10),
  includeShortsIdeas: z.boolean().default(true),
  maxVideosInContext: z.number().int().min(5).max(200).default(60),
  refresh: z.enum(["manual", "daily", "weekly"]).default("manual"),
}).strict();

const seoSchema = z.object({
  titleOptions: z.number().int().min(1).max(10).default(5),
  maxTitleChars: z.number().int().min(30).max(100).default(70),
  descriptionTemplate: longText(5000).default("{{summary}}\n\n{{chapters}}\n\n{{cta}}\n\n{{hashtags}}"),
  maxTags: z.number().int().min(0).max(30).default(12),
  maxHashtags: z.number().int().min(0).max(15).default(3),
  includeChapters: z.boolean().default(true),
  ctaGuidance: shortText(500).default("Invite viewers to subscribe and watch a related video. No fake urgency."),
  bannedPhrases: z.array(shortText(60)).max(50).default(["you won't believe", "shocking", "guaranteed"]),
}).strict();

const publishingSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["manual", "approval", "rule_based"]).default("approval"),
  defaultPrivacy: z.enum(["private", "unlisted", "public"]).default("private"),
  categoryId: z.string().regex(/^\d{1,3}$/).default("22"),
  madeForKids: z.boolean().default(false),
  uploadCaptions: z.boolean().default(false),
  rules: z.object({
    /** Rule-based mode may only auto-publish at these visibilities. */
    autoPrivacy: z.enum(["private", "unlisted"]).default("private"),
    scheduleDays: z.array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"])).default([]),
    scheduleTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("15:00"),
  }).strict().prefault({}),
}).strict();

/* ── agent ────────────────────────────────────────────────────────────── */

export const agentConfigSchema = z.object({
  modules: z.object({
    ideation: ideationSchema.prefault({}),
    editing: editingSchema.prefault({}),
    publishing: publishingSchema.prefault({}),
  }).strict(),
  instructions: z.object({
    system: longText().default(""),
    channelAnalysis: longText().default(""),
    ideation: longText().default(""),
    editing: longText().default(""),
    metadata: longText().default(""),
  }).strict(),
  models: z.object({ llm: modelPrefsSchema, transcription: transcriptionPrefsSchema }).strict(),
  seo: seoSchema.prefault({}),
  renderPresets: z.array(renderPresetSchema).min(1).max(12),
  approvalGates: z.object({
    ideas: z.boolean().default(true),
    editPlan: z.boolean().default(true),
    finalRender: z.boolean().default(true),
    publish: z.boolean().default(true),
  }).strict().prefault({}),
  policies: z.object({
    retry: z.object({ maxAttempts: z.number().int().min(1).max(10).default(3), backoffSeconds: z.number().int().min(1).max(3600).default(30) }).strict().prefault({}),
    timeouts: z.object({
      defaultSeconds: z.number().int().min(30).max(7200).default(600),
      transcriptionSeconds: z.number().int().min(60).max(14400).default(3600),
      renderSeconds: z.number().int().min(60).max(21600).default(7200),
      uploadSeconds: z.number().int().min(60).max(21600).default(7200),
    }).strict().prefault({}),
  }).strict().prefault({}),
  workflows: z.array(workflowSchema).max(20),
  integrations: z.array(integrationRefSchema).max(12),
  env: z.array(envVarSchema).max(40),
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
  /** Creator-profile fields a deployment must fill in before activation. */
  requiredClientSettings: z.array(z.enum([
    "niche", "targetAudience", "audienceProblems", "formats", "tone", "goals", "publishingFrequency", "brandVoice",
  ])).max(8).default([]),
  /** Illustrative, fictional profile values for documentation. Never real client data. */
  exampleClientSettings: z.record(z.string(), z.union([z.string().max(300), z.array(z.string().max(120)).max(10)])).optional(),
}).strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type RenderPreset = z.infer<typeof renderPresetSchema>;
export type CaptionStyle = z.infer<typeof captionStyleSchema>;
export type IntegrationRef = z.infer<typeof integrationRefSchema>;

/* ── the portable document ────────────────────────────────────────────── */

export const blueprintSchema = z.object({
  format: z.literal(BLUEPRINT_FORMAT),
  schemaVersion: semver,
  blueprint: z.object({
    uid: z.uuid(),
    name: z.string().min(1).max(120),
    description: z.string().max(2000),
    version: semver,
    changelog: z.string().max(4000).default(""),
    createdAt: z.iso.datetime({ offset: true }),
  }).strict(),
  compatibility: z.object({ minAppVersion: semver, schemaVersion: semver }).strict(),
  config: agentConfigSchema,
}).strict();

export type Blueprint = z.infer<typeof blueprintSchema>;

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

export function bumpVersion(v: string, part: "major" | "minor" | "patch"): string {
  const [ma, mi, pa] = v.split(".").map(Number);
  if (part === "major") return `${ma + 1}.0.0`;
  if (part === "minor") return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}
