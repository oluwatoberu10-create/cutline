import { agentConfigSchema, type AgentConfig } from "./schema";

/**
 * The starter agent every new template begins from. It is also the basis of
 * docs/sample-blueprint.json. Contains no client data and no secret values.
 */
const RAW = {
  modules: {
    ideation: { enabled: true, batchSize: 10, includeShortsIdeas: true, maxVideosInContext: 60, refresh: "manual" },
    editing: { enabled: true, mode: "review_first" },
    publishing: { enabled: true, mode: "approval", defaultPrivacy: "private" },
  },
  instructions: {
    system:
      "You are a YouTube content strategist and editor working for one creator. Ground every recommendation in the " +
      "data you are given. Clearly separate measured facts from your own hypotheses. Never promise views, virality " +
      "or rankings, never invent statistics, and never reference videos that are not in the provided list.",
    channelAnalysis:
      "Identify recurring subjects, what appears to resonate (relative to the channel's own baseline), gaps between " +
      "the creator's stated goals and their recent uploads, overused topics, videos that deserve a follow-up, and " +
      "series opportunities. Label every point as a hypothesis with the evidence it rests on.",
    ideation:
      "Propose ideas that fit the creator's niche, audience and tone. Prefer ideas that build on proven topics or fill " +
      "clear gaps. Each idea must explain why it fits this specific channel and cite supporting videos by id when relevant.",
    editing:
      "Pick moments that are self-contained, open strongly and would make sense to a new viewer. Prefer concrete, " +
      "quotable statements over filler. Do not suggest removing content that changes the meaning of what was said.",
    metadata:
      "Write accurate, specific titles and descriptions that reflect what is actually in the video transcript. No " +
      "clickbait that the video does not deliver on, no keyword stuffing, no irrelevant hashtags.",
  },
  models: {
    llm: { ref: "llm_provider", preferences: [{ provider: "anthropic", model: "claude-opus-5-5" }, { provider: "openai", model: "gpt-5" }], effort: "medium", maxOutputTokens: 16000 },
    transcription: { ref: "transcription_provider", preferences: [{ provider: "openai", model: "whisper-1" }, { provider: "deepgram", model: "nova-3" }], diarization: false },
  },
  seo: {},
  renderPresets: [
    { id: "draft-540p", label: "Draft 540p (review)", width: 960, height: 540, fps: 30, container: "mp4", crf: 30, speed: "ultrafast", audioBitrateK: 96 },
    { id: "final-1080p", label: "Final 1080p", width: 1920, height: 1080, fps: 30, container: "mp4", crf: 20, speed: "medium", audioBitrateK: 192 },
    { id: "final-720p", label: "Final 720p", width: 1280, height: 720, fps: 30, container: "mp4", crf: 21, speed: "fast", audioBitrateK: 160 },
    { id: "shorts-1080x1920", label: "Shorts 1080×1920", width: 1080, height: 1920, fps: 30, container: "mp4", crf: 21, speed: "fast", audioBitrateK: 160 },
    { id: "square-1080", label: "Square 1080", width: 1080, height: 1080, fps: 30, container: "mp4", crf: 21, speed: "fast", audioBitrateK: 160 },
  ],
  approvalGates: { ideas: true, editPlan: true, finalRender: true, publish: true },
  policies: {},
  workflows: [
    {
      key: "channel_intelligence",
      name: "Channel intelligence",
      description: "Sync the channel, analyse it and propose a batch of content ideas for review.",
      trigger: { type: "manual" },
      inputs: [],
      nodes: [
        { id: "sync", type: "channel.sync", config: { maxVideos: 200 }, dependsOn: [] },
        { id: "analyze", type: "channel.analyze", config: { useLlm: true }, dependsOn: ["sync"] },
        { id: "ideas", type: "ideas.generate", config: {}, dependsOn: ["analyze"], when: { path: "config.modules.ideation.enabled", op: "eq", value: true } },
        {
          id: "review_ideas", type: "approval.gate", dependsOn: ["ideas"],
          config: { kind: "ideas", title: "Review the new idea batch", subject: { $from: "steps.ideas.output.batchId" } },
          when: { path: "config.approvalGates.ideas", op: "eq", value: true },
        },
      ],
    },
    {
      key: "footage_to_publish",
      name: "Footage to published video",
      description: "Transcribe a recording, propose a first cut, render it for review, then prepare metadata and publish.",
      trigger: { type: "manual" },
      inputs: [
        { key: "assetId", label: "Raw recording", kind: "media_asset", required: true },
        { key: "ideaId", label: "Content idea (optional)", kind: "content_idea", required: false },
      ],
      nodes: [
        { id: "transcribe", type: "media.transcribe", config: { asset: { $from: "input.assetId" } }, dependsOn: [] },
        { id: "propose", type: "edit.propose", config: { asset: { $from: "input.assetId" }, idea: { $from: "input.ideaId" }, useLlm: true }, dependsOn: ["transcribe"] },
        { id: "draft", type: "render.draft", config: { edit: { $from: "steps.propose.output.editProjectId" } }, dependsOn: ["propose"] },
        {
          id: "review_edit", type: "approval.gate", dependsOn: ["draft", "propose"],
          config: { kind: "edit", title: "Review the draft cut", subject: { $from: "steps.propose.output.editProjectId" } },
          when: { path: "config.modules.editing.mode", op: "neq", value: "automatic" },
        },
        { id: "final", type: "render.final", config: { edit: { $from: "steps.propose.output.editProjectId" } }, dependsOn: ["review_edit", "propose"] },
        {
          id: "metadata", type: "metadata.generate", dependsOn: ["final", "propose"],
          config: { edit: { $from: "steps.propose.output.editProjectId" }, render: { $from: "steps.final.output.renderJobId" } },
          when: { path: "config.modules.publishing.enabled", op: "eq", value: true },
        },
        {
          id: "review_publish", type: "approval.gate", dependsOn: ["metadata"],
          config: { kind: "publish", title: "Approve upload to YouTube", subject: { $from: "steps.metadata.output.publishingJobId" } },
          when: { path: "config.modules.publishing.mode", op: "neq", value: "rule_based" },
        },
        { id: "upload", type: "publish.upload", config: { publishingJob: { $from: "steps.metadata.output.publishingJobId" } }, dependsOn: ["review_publish", "metadata"] },
        { id: "track", type: "publish.track", config: { publishingJob: { $from: "steps.metadata.output.publishingJobId" } }, dependsOn: ["upload", "metadata"] },
      ],
    },
  ],
  integrations: [
    { ref: "youtube_connection", kind: "youtube", required: true, purpose: "Read channel data and analytics; upload videos when publishing is enabled.", scopes: ["youtube.readonly", "yt-analytics.readonly", "youtube.upload"] },
    { ref: "llm_provider", kind: "llm", required: true, purpose: "Channel analysis hypotheses, content ideas, highlight picking and metadata drafting." },
    { ref: "transcription_provider", kind: "transcription", required: true, purpose: "Speech-to-text with timestamps for footage editing." },
    { ref: "media_storage", kind: "storage", required: true, purpose: "Original footage, working copies and renders." },
  ],
  env: [
    { name: "GOOGLE_OAUTH_CLIENT_ID", required: true, secret: false, description: "OAuth client id of the installation's Google Cloud project (YouTube Data + Analytics APIs enabled).", example: "<your-client-id>.apps.googleusercontent.com" },
    { name: "GOOGLE_OAUTH_CLIENT_SECRET", required: true, secret: true, description: "OAuth client secret for the client id above." },
    { name: "YOUTUBE_API_KEY", required: false, secret: true, description: "Optional: API key for public-channel research without OAuth." },
    { name: "ANTHROPIC_API_KEY", required: false, secret: true, description: "Installation-wide Anthropic key (workspaces can instead store their own)." },
    { name: "OPENAI_API_KEY", required: false, secret: true, description: "Installation-wide OpenAI key for LLM and/or Whisper transcription." },
    { name: "DEEPGRAM_API_KEY", required: false, secret: true, description: "Installation-wide Deepgram key for transcription." },
    { name: "CUTLINE_ENCRYPTION_KEY", required: true, secret: true, description: "32-byte base64 key that encrypts stored tokens and keys." },
    { name: "CUTLINE_SIGNING_SECRET", required: true, secret: true, description: "Secret for short-lived signed media URLs." },
  ],
  capabilities: ["ffmpeg", "ffprobe", "llm.structured_json", "transcription.timestamps", "youtube.data", "youtube.upload"],
  requiredClientSettings: ["niche", "targetAudience", "tone"],
  exampleClientSettings: {
    niche: "Example: home espresso for beginners",
    targetAudience: "Example: people who just bought their first espresso machine",
    tone: "Example: friendly, practical, no jargon",
  },
};

export function defaultAgentConfig(): AgentConfig {
  return agentConfigSchema.parse(structuredClone(RAW));
}
