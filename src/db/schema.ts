/**
 * Cutline database schema.
 *
 * Tenancy model
 * ─────────────
 *   organization (the agency)  ──<  workspace (one per client / creator)
 *
 * Every client-owned row carries `workspaceId` and is only ever read through
 * the workspace-scoped helpers in src/server/tenancy.ts, which first prove the
 * actor may access that workspace. Agency-level rows (templates, blueprint
 * versions, agency-shared connections) carry `orgId` only.
 *
 * Secrets never live in ordinary columns: OAuth tokens and API keys are
 * AES-256-GCM encrypted in `credentials.ciphertext` and nothing outside
 * src/server/secrets.ts decrypts them.
 */
import { sql } from "drizzle-orm";
import {
  bigserial, boolean, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, primaryKey, real,
  text, timestamp, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid().primaryKey().defaultRandom();
const created = () => timestamp({ withTimezone: true }).notNull().defaultNow();
const ts = () => timestamp({ withTimezone: true });

/* ── identity ─────────────────────────────────────────────────────────── */

export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const users = pgTable("users", {
  id: id(),
  email: text().notNull(),
  name: text().notNull(),
  passwordHash: text().notNull(),
  status: userStatus().notNull().default("active"),
  createdAt: created(),
  lastLoginAt: ts(),
}, (t) => [uniqueIndex("users_email_uq").on(sql`lower(${t.email})`)]);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text().notNull().unique(),
  userAgent: text(),
  expiresAt: ts().notNull(),
  createdAt: created(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

/** Personal API tokens for the documented REST API. Only the hash is stored. */
export const apiTokens = pgTable("api_tokens", {
  id: id(),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text().notNull(),
  prefix: text().notNull(),
  tokenHash: text().notNull().unique(),
  lastUsedAt: ts(),
  expiresAt: ts(),
  revokedAt: ts(),
  createdAt: created(),
});

/* ── organizations & workspaces ───────────────────────────────────────── */

export const orgRole = pgEnum("org_role", ["admin", "member"]);
export const workspaceRole = pgEnum("workspace_role", ["owner", "editor", "viewer"]);
export const workspaceStatus = pgEnum("workspace_status", ["active", "archived"]);
export const ownershipMode = pgEnum("ownership_mode", ["agency_managed", "client_owned"]);

export const organizations = pgTable("organizations", {
  id: id(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  /** Agency preferences, usage limits and security policy. Shape: OrgSettings in lib/settings.ts. */
  settings: jsonb().notNull().default({}),
  createdAt: created(),
});

export const orgMemberships = pgTable("org_memberships", {
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  role: orgRole().notNull(),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("org_memberships_user_idx").on(t.userId)]);

export const workspaces = pgTable("workspaces", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  name: text().notNull(),
  slug: text().notNull(),
  status: workspaceStatus().notNull().default("active"),
  ownershipMode: ownershipMode().notNull().default("agency_managed"),
  contactEmail: text(),
  timezone: text().notNull().default("UTC"),
  /** Approval modes, retention, processing limits. Shape: WorkspaceSettings in lib/settings.ts. */
  settings: jsonb().notNull().default({}),
  createdAt: created(),
  archivedAt: ts(),
}, (t) => [uniqueIndex("workspaces_org_slug_uq").on(t.orgId, t.slug), index("workspaces_org_idx").on(t.orgId)]);

export const workspaceMemberships = pgTable("workspace_memberships", {
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  role: workspaceRole().notNull(),
  createdAt: created(),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("ws_memberships_user_idx").on(t.userId)]);

export const invites = pgTable("invites", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
  email: text().notNull(),
  orgRole: orgRole(),
  workspaceRole: workspaceRole(),
  tokenHash: text().notNull().unique(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  expiresAt: ts().notNull(),
  acceptedAt: ts(),
  createdAt: created(),
});

/* ── credentials & connections ────────────────────────────────────────── */

export const connectionKind = pgEnum("connection_kind", ["youtube", "llm", "transcription", "storage"]);
export const connectionStatus = pgEnum("connection_status", ["connected", "error", "revoked", "pending"]);

/**
 * Encrypted secret material. `ciphertext` is AES-256-GCM over a JSON payload
 * (OAuth tokens, an API key, S3 keys). Never selected by UI or API code.
 */
export const credentials = pgTable("credentials", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  ciphertext: text().notNull(),
  keyVersion: integer().notNull().default(1),
  createdAt: created(),
  rotatedAt: ts(),
});

/**
 * A configured integration. `workspaceId = null` means an agency-shared
 * provider (e.g. the agency's own LLM key) that workspaces may use only when
 * their settings allow it. Client-owned YouTube connections are always
 * workspace-scoped.
 */
export const connections = pgTable("connections", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: connectionKind().notNull(),
  provider: text().notNull(),
  label: text().notNull(),
  status: connectionStatus().notNull().default("connected"),
  externalAccountId: text(),
  externalAccountName: text(),
  scopes: text().array().notNull().default(sql`'{}'::text[]`),
  /** Non-secret settings: model, bucket, region, endpoint. */
  config: jsonb().notNull().default({}),
  credentialId: uuid().references(() => credentials.id, { onDelete: "set null" }),
  lastCheckedAt: ts(),
  lastError: text(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  revokedAt: ts(),
}, (t) => [index("connections_ws_idx").on(t.workspaceId), index("connections_org_idx").on(t.orgId)]);

/** Short-lived OAuth state for the authorization-code + PKCE flow. */
export const oauthStates = pgTable("oauth_states", {
  stateHash: text().primaryKey(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid().notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text().notNull(),
  codeVerifierCiphertext: text().notNull(),
  scopes: text().array().notNull(),
  returnTo: text().notNull(),
  expiresAt: ts().notNull(),
  createdAt: created(),
});

/* ── creator profile & channel intelligence ───────────────────────────── */

export const creatorProfiles = pgTable("creator_profiles", {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: "cascade" }),
  niche: text().notNull().default(""),
  targetAudience: text().notNull().default(""),
  audienceProblems: text().array().notNull().default(sql`'{}'::text[]`),
  audienceInterests: text().array().notNull().default(sql`'{}'::text[]`),
  formats: text().array().notNull().default(sql`'{}'::text[]`),
  preferredLengthMin: integer(),
  preferredLengthMax: integer(),
  tone: text().notNull().default(""),
  goals: text().notNull().default(""),
  avoidTopics: text().array().notNull().default(sql`'{}'::text[]`),
  competitorChannels: text().array().notNull().default(sql`'{}'::text[]`),
  contentCategories: text().array().notNull().default(sql`'{}'::text[]`),
  publishingFrequency: text().notNull().default(""),
  brandVoice: text().notNull().default(""),
  /** Free-form preferences the creator explicitly saved ("never use clickbait", …). */
  savedPreferences: text().array().notNull().default(sql`'{}'::text[]`),
  updatedAt: created(),
});

export const channelSource = pgEnum("channel_source", ["oauth", "public"]);

export const channels = pgTable("channels", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  source: channelSource().notNull(),
  connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
  youtubeChannelId: text().notNull(),
  title: text().notNull(),
  handle: text(),
  description: text().notNull().default(""),
  thumbnailUrl: text(),
  subscriberCount: integer(),
  videoCount: integer(),
  viewCount: doublePrecision(),
  uploadsPlaylistId: text(),
  isPrimary: boolean().notNull().default(false),
  lastSyncedAt: ts(),
  /** What the last sync could and could not retrieve, with reasons. */
  access: jsonb().notNull().default({}),
  createdAt: created(),
}, (t) => [uniqueIndex("channels_ws_yt_uq").on(t.workspaceId, t.youtubeChannelId)]);

export const channelSnapshots = pgTable("channel_snapshots", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channelId: uuid().notNull().references(() => channels.id, { onDelete: "cascade" }),
  stats: jsonb().notNull(),
  access: jsonb().notNull(),
  takenAt: created(),
});

export const videos = pgTable("videos", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channelId: uuid().notNull().references(() => channels.id, { onDelete: "cascade" }),
  youtubeVideoId: text().notNull(),
  title: text().notNull(),
  description: text().notNull().default(""),
  publishedAt: ts(),
  durationSeconds: integer(),
  thumbnailUrl: text(),
  tags: text().array().notNull().default(sql`'{}'::text[]`),
  categoryId: text(),
  privacyStatus: text(),
  viewCount: doublePrecision(),
  likeCount: doublePrecision(),
  commentCount: doublePrecision(),
  /** YouTube Analytics metrics when the creator authorised them; null otherwise. */
  analytics: jsonb(),
  updatedAt: created(),
}, (t) => [uniqueIndex("videos_ws_yt_uq").on(t.workspaceId, t.youtubeVideoId), index("videos_channel_idx").on(t.channelId)]);

export const playlists = pgTable("playlists", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channelId: uuid().notNull().references(() => channels.id, { onDelete: "cascade" }),
  youtubePlaylistId: text().notNull(),
  title: text().notNull(),
  itemCount: integer(),
}, (t) => [uniqueIndex("playlists_ws_yt_uq").on(t.workspaceId, t.youtubePlaylistId)]);

export const channelAnalyses = pgTable("channel_analyses", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  channelId: uuid().notNull().references(() => channels.id, { onDelete: "cascade" }),
  /** Deterministic findings computed from stored data. */
  measured: jsonb().notNull(),
  /** Model-generated hypotheses, labelled as such. Null when no LLM was available. */
  hypotheses: jsonb(),
  provider: text(),
  model: text(),
  isMock: boolean().notNull().default(false),
  createdAt: created(),
});

export const ideaStatus = pgEnum("idea_status", ["proposed", "saved", "approved", "rejected", "in_production", "published", "archived"]);

export const contentIdeas = pgTable("content_ideas", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  batchId: uuid(),
  analysisId: uuid().references(() => channelAnalyses.id, { onDelete: "set null" }),
  status: ideaStatus().notNull().default("proposed"),
  title: text().notNull(),
  concept: text().notNull(),
  topic: text().notNull().default(""),
  targetAudience: text().notNull().default(""),
  audienceNeed: text().notNull().default(""),
  fitReason: text().notNull().default(""),
  supportingVideoIds: text().array().notNull().default(sql`'{}'::text[]`),
  hook: text().notNull().default(""),
  outline: jsonb().notNull().default([]),
  format: text().notNull().default(""),
  lengthMinutes: integer(),
  keywords: text().array().notNull().default(sql`'{}'::text[]`),
  shortsOpportunities: text().array().notNull().default(sql`'{}'::text[]`),
  priorityScore: integer().notNull().default(50),
  priorityReason: text().notNull().default(""),
  evidenceNotes: text().notNull().default(""),
  provider: text(),
  model: text(),
  isMock: boolean().notNull().default(false),
  createdAt: created(),
  updatedAt: created(),
}, (t) => [index("ideas_ws_status_idx").on(t.workspaceId, t.status)]);

/** Explicit creator feedback — the only signal used to personalise future ideas. */
export const ideaFeedback = pgTable("idea_feedback", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ideaId: uuid().notNull().references(() => contentIdeas.id, { onDelete: "cascade" }),
  userId: uuid().references(() => users.id, { onDelete: "set null" }),
  action: text().notNull(),
  reason: text().notNull().default(""),
  createdAt: created(),
});

export const calendarEntries = pgTable("calendar_entries", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ideaId: uuid().notNull().references(() => contentIdeas.id, { onDelete: "cascade" }),
  publishDate: date({ mode: "string" }).notNull(),
  status: text().notNull().default("planned"),
  notes: text().notNull().default(""),
  createdAt: created(),
}, (t) => [uniqueIndex("calendar_idea_uq").on(t.ideaId)]);

/* ── media ────────────────────────────────────────────────────────────── */

export const assetKind = pgEnum("asset_kind", ["video", "audio", "image"]);
export const assetRole = pgEnum("asset_role", ["source", "brand", "intro", "outro", "render"]);
export const assetStatus = pgEnum("asset_status", ["uploading", "processing", "ready", "failed", "deleted"]);

export const projects = pgTable("projects", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  title: text().notNull(),
  ideaId: uuid().references(() => contentIdeas.id, { onDelete: "set null" }),
  recordingDate: date({ mode: "string" }),
  createdAt: created(),
});

export const mediaAssets = pgTable("media_assets", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
  kind: assetKind().notNull(),
  role: assetRole().notNull().default("source"),
  status: assetStatus().notNull().default("uploading"),
  originalFilename: text().notNull(),
  mimeType: text().notNull(),
  sizeBytes: doublePrecision().notNull().default(0),
  sha256: text(),
  storageDriver: text().notNull(),
  /** The untouched original. Never overwritten or transcoded in place. */
  storageKey: text().notNull(),
  /** Working copies derived from the original. */
  proxyKey: text(),
  audioKey: text(),
  thumbnailKey: text(),
  probe: jsonb(),
  durationSeconds: doublePrecision(),
  width: integer(),
  height: integer(),
  fps: doublePrecision(),
  hasVideo: boolean().notNull().default(false),
  hasAudio: boolean().notNull().default(false),
  /** Silence ranges detected by FFmpeg (measured, not AI). */
  silences: jsonb(),
  error: text(),
  recordedAt: date({ mode: "string" }),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  deletedAt: ts(),
}, (t) => [index("assets_ws_idx").on(t.workspaceId, t.role)]);

export const uploadSessions = pgTable("upload_sessions", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  assetId: uuid().notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  totalBytes: doublePrecision().notNull(),
  chunkBytes: integer().notNull(),
  totalParts: integer().notNull(),
  receivedParts: integer().array().notNull().default(sql`'{}'::integer[]`),
  status: text().notNull().default("open"),
  expiresAt: ts().notNull(),
  createdAt: created(),
});

export const transcripts = pgTable("transcripts", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  assetId: uuid().notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  provider: text().notNull(),
  model: text(),
  language: text(),
  /** [{ id, start, end, text, speaker?, words?: [{ w, start, end }] }] in source seconds. */
  segments: jsonb().notNull(),
  hasWordTimings: boolean().notNull().default(false),
  hasSpeakers: boolean().notNull().default(false),
  isMock: boolean().notNull().default(false),
  createdAt: created(),
}, (t) => [uniqueIndex("transcripts_asset_uq").on(t.assetId)]);

/* ── editing ──────────────────────────────────────────────────────────── */

export const editStatus = pgEnum("edit_status", ["draft", "in_review", "approved", "rendering", "rendered", "failed"]);
export const editingMode = pgEnum("editing_mode", ["assisted", "review_first", "automatic"]);

export const editProjects = pgTable("edit_projects", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  projectId: uuid().references(() => projects.id, { onDelete: "set null" }),
  ideaId: uuid().references(() => contentIdeas.id, { onDelete: "set null" }),
  parentEditId: uuid(),
  /** Set when an agent step created this project, so a retried step finds it instead of duplicating. */
  sourceKey: text().unique(),
  title: text().notNull(),
  format: text().notNull().default("long"),
  status: editStatus().notNull().default("draft"),
  editingMode: editingMode().notNull().default("review_first"),
  /** The edit-decision list (lib/edl.ts). Source footage is referenced, never embedded. */
  edl: jsonb().notNull(),
  edlVersion: integer().notNull().default(1),
  approvedVersion: integer(),
  approvedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  approvedAt: ts(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  updatedAt: created(),
}, (t) => [index("edits_ws_idx").on(t.workspaceId)]);

export const edlRevisions = pgTable("edl_revisions", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  editProjectId: uuid().notNull().references(() => editProjects.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  edl: jsonb().notNull(),
  note: text().notNull().default(""),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
}, (t) => [uniqueIndex("edl_rev_uq").on(t.editProjectId, t.version)]);

export const editSuggestions = pgTable("edit_suggestions", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  editProjectId: uuid().notNull().references(() => editProjects.id, { onDelete: "cascade" }),
  assetId: uuid().notNull().references(() => mediaAssets.id, { onDelete: "cascade" }),
  type: text().notNull(),
  start: doublePrecision().notNull(),
  end: doublePrecision().notNull(),
  text: text().notNull().default(""),
  reason: text().notNull().default(""),
  confidence: real(),
  /** "measured" (FFmpeg/transcript timing) or "ai" (model judgement). */
  origin: text().notNull(),
  status: text().notNull().default("proposed"),
  createdAt: created(),
}, (t) => [index("suggestions_edit_idx").on(t.editProjectId)]);

export const renderStatus = pgEnum("render_status", ["queued", "running", "succeeded", "failed", "cancelled"]);

export const renderJobs = pgTable("render_jobs", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  editProjectId: uuid().notNull().references(() => editProjects.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  edlVersion: integer().notNull(),
  status: renderStatus().notNull().default("queued"),
  progress: integer().notNull().default(0),
  output: jsonb().notNull(),
  outputAssetId: uuid().references(() => mediaAssets.id, { onDelete: "set null" }),
  captionsKey: text(),
  error: text(),
  /** One render per (edit, version, kind, preset): retries reuse it instead of duplicating. */
  idempotencyKey: text().notNull().unique(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  startedAt: ts(),
  finishedAt: ts(),
});

/* ── publishing ───────────────────────────────────────────────────────── */

export const publishStatus = pgEnum("publish_status", [
  "draft", "awaiting_approval", "approved", "uploading", "processing", "scheduled", "published", "failed", "cancelled",
]);

export const publishingJobs = pgTable("publishing_jobs", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  editProjectId: uuid().references(() => editProjects.id, { onDelete: "set null" }),
  renderJobId: uuid().references(() => renderJobs.id, { onDelete: "set null" }),
  outputAssetId: uuid().notNull().references(() => mediaAssets.id, { onDelete: "restrict" }),
  connectionId: uuid().references(() => connections.id, { onDelete: "set null" }),
  status: publishStatus().notNull().default("draft"),
  /** Editable metadata: lib/metadata.ts PublishMetadata. */
  metadata: jsonb().notNull(),
  /** Alternatives offered by the metadata agent (titles, thumbnail concepts…). */
  suggestions: jsonb(),
  metadataProvider: text(),
  isMock: boolean().notNull().default(false),
  idempotencyKey: text().notNull().unique(),
  /** Resumable-upload session URI (a bearer capability) — encrypted. */
  uploadSessionCiphertext: text(),
  bytesUploaded: doublePrecision().notNull().default(0),
  youtubeVideoId: text(),
  youtubeStatus: jsonb(),
  approvedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  approvedAt: ts(),
  error: text(),
  attempts: integer().notNull().default(0),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  updatedAt: created(),
}, (t) => [index("publishing_ws_idx").on(t.workspaceId, t.status)]);

/* ── approvals ────────────────────────────────────────────────────────── */

export const approvalStatus = pgEnum("approval_status", ["pending", "approved", "rejected", "cancelled"]);

export const approvalRequests = pgTable("approval_requests", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  kind: text().notNull(),
  title: text().notNull(),
  subjectType: text().notNull(),
  subjectId: uuid(),
  status: approvalStatus().notNull().default("pending"),
  payload: jsonb().notNull().default({}),
  workflowRunId: uuid(),
  stepRunId: uuid(),
  requestedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  decidedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  decidedAt: ts(),
  note: text().notNull().default(""),
  createdAt: created(),
}, (t) => [index("approvals_ws_status_idx").on(t.workspaceId, t.status)]);

/* ── agent templates, blueprints & deployments ────────────────────────── */

export const agentTemplates = pgTable("agent_templates", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** Stable blueprint identity shared by every version, including across installations. */
  blueprintUid: uuid().notNull(),
  name: text().notNull(),
  description: text().notNull().default(""),
  /** The editable working copy (lib/blueprint/schema.ts AgentConfig). */
  draftConfig: jsonb().notNull(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  updatedAt: created(),
  archivedAt: ts(),
}, (t) => [uniqueIndex("templates_org_uid_uq").on(t.orgId, t.blueprintUid)]);

/** Immutable, published blueprint versions. Deployments pin one of these. */
export const blueprintVersions = pgTable("blueprint_versions", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  templateId: uuid().notNull().references(() => agentTemplates.id, { onDelete: "cascade" }),
  blueprintUid: uuid().notNull(),
  version: text().notNull(),
  schemaVersion: text().notNull(),
  content: jsonb().notNull(),
  contentHash: text().notNull(),
  changelog: text().notNull().default(""),
  source: text().notNull().default("published"),
  importReport: jsonb(),
  status: text().notNull().default("active"),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
}, (t) => [uniqueIndex("bp_versions_tpl_ver_uq").on(t.templateId, t.version), index("bp_versions_org_idx").on(t.orgId)]);

export const deploymentStatus = pgEnum("deployment_status", ["draft", "ready", "active", "paused", "failed"]);

/** A blueprint version deployed into one client workspace. */
export const agentDeployments = pgTable("agent_deployments", {
  id: id(),
  orgId: uuid().notNull().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  templateId: uuid().notNull().references(() => agentTemplates.id, { onDelete: "restrict" }),
  blueprintVersionId: uuid().notNull().references(() => blueprintVersions.id, { onDelete: "restrict" }),
  status: deploymentStatus().notNull().default("draft"),
  wizardStep: integer().notNull().default(1),
  /** Client-specific settings layered over the blueprint defaults. */
  overrides: jsonb().notNull().default({}),
  /** Logical integration ref → connection id, e.g. { youtube_connection: "<uuid>" }. */
  bindings: jsonb().notNull().default({}),
  validation: jsonb(),
  testResults: jsonb(),
  currentRevision: integer().notNull().default(0),
  activatedAt: ts(),
  activatedBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  updatedAt: created(),
}, (t) => [uniqueIndex("deployments_ws_uq").on(t.workspaceId)]);

/** Every applied configuration, so a deployment can be rolled back exactly. */
export const deploymentRevisions = pgTable("deployment_revisions", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  deploymentId: uuid().notNull().references(() => agentDeployments.id, { onDelete: "cascade" }),
  revision: integer().notNull(),
  blueprintVersionId: uuid().notNull().references(() => blueprintVersions.id, { onDelete: "restrict" }),
  overrides: jsonb().notNull(),
  bindings: jsonb().notNull(),
  effectiveConfig: jsonb().notNull(),
  reason: text().notNull(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
}, (t) => [uniqueIndex("dep_rev_uq").on(t.deploymentId, t.revision)]);

/* ── workflow engine & jobs ───────────────────────────────────────────── */

export const runStatus = pgEnum("run_status", ["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);
export const stepStatus = pgEnum("step_status", ["pending", "running", "waiting", "succeeded", "failed", "skipped", "cancelled"]);

export const workflowRuns = pgTable("workflow_runs", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  deploymentId: uuid().references(() => agentDeployments.id, { onDelete: "set null" }),
  workflowKey: text().notNull(),
  workflowName: text().notNull(),
  /** Snapshot of the definition at start, so later blueprint edits never alter a running run. */
  definition: jsonb().notNull(),
  status: runStatus().notNull().default("queued"),
  trigger: text().notNull().default("manual"),
  input: jsonb().notNull().default({}),
  error: text(),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  startedAt: ts(),
  finishedAt: ts(),
}, (t) => [index("runs_ws_idx").on(t.workspaceId, t.status)]);

export const stepRuns = pgTable("step_runs", {
  id: id(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  runId: uuid().notNull().references(() => workflowRuns.id, { onDelete: "cascade" }),
  nodeId: text().notNull(),
  nodeType: text().notNull(),
  status: stepStatus().notNull().default("pending"),
  attempt: integer().notNull().default(0),
  output: jsonb(),
  error: text(),
  startedAt: ts(),
  finishedAt: ts(),
}, (t) => [uniqueIndex("step_runs_run_node_uq").on(t.runId, t.nodeId)]);

export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);

/**
 * The durable work queue. Workers claim rows with FOR UPDATE SKIP LOCKED and
 * hold a lease (`lockedUntil`); a crashed worker's lease simply expires and the
 * job is claimed again. `dedupeKey` stops the same work being queued twice
 * while an earlier copy is still pending.
 */
export const jobs = pgTable("jobs", {
  id: id(),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
  type: text().notNull(),
  payload: jsonb().notNull().default({}),
  status: jobStatus().notNull().default("queued"),
  attempts: integer().notNull().default(0),
  maxAttempts: integer().notNull().default(3),
  timeoutSeconds: integer().notNull().default(900),
  runAt: created(),
  lockedBy: text(),
  lockedUntil: ts(),
  progress: integer().notNull().default(0),
  progressNote: text(),
  result: jsonb(),
  error: text(),
  dedupeKey: text(),
  runId: uuid().references(() => workflowRuns.id, { onDelete: "cascade" }),
  stepRunId: uuid().references(() => stepRuns.id, { onDelete: "cascade" }),
  cancelRequested: boolean().notNull().default(false),
  createdBy: uuid().references(() => users.id, { onDelete: "set null" }),
  createdAt: created(),
  startedAt: ts(),
  finishedAt: ts(),
}, (t) => [
  index("jobs_claim_idx").on(t.status, t.runAt),
  index("jobs_ws_idx").on(t.workspaceId, t.createdAt),
  uniqueIndex("jobs_dedupe_active_uq").on(t.dedupeKey).where(sql`${t.status} in ('queued','running') and ${t.dedupeKey} is not null`),
]);

export const runLogs = pgTable("run_logs", {
  id: bigserial({ mode: "number" }).primaryKey(),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
  jobId: uuid().references(() => jobs.id, { onDelete: "cascade" }),
  runId: uuid().references(() => workflowRuns.id, { onDelete: "cascade" }),
  level: text().notNull(),
  message: text().notNull(),
  data: jsonb(),
  at: created(),
}, (t) => [index("run_logs_job_idx").on(t.jobId), index("run_logs_run_idx").on(t.runId)]);

/* ── governance ───────────────────────────────────────────────────────── */

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  orgId: uuid().references(() => organizations.id, { onDelete: "cascade" }),
  workspaceId: uuid().references(() => workspaces.id, { onDelete: "cascade" }),
  actorId: uuid().references(() => users.id, { onDelete: "set null" }),
  action: text().notNull(),
  entityType: text().notNull(),
  entityId: text(),
  summary: text().notNull(),
  metadata: jsonb().notNull().default({}),
  ip: text(),
  at: created(),
}, (t) => [index("audit_org_idx").on(t.orgId, t.at), index("audit_ws_idx").on(t.workspaceId, t.at)]);

export const rateLimits = pgTable("rate_limits", {
  key: text().primaryKey(),
  windowStart: timestamp({ withTimezone: true }).notNull(),
  count: integer().notNull(),
});

/** Monthly usage per workspace, checked against configured processing limits. */
export const usageCounters = pgTable("usage_counters", {
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  period: text().notNull(),
  metric: text().notNull(),
  value: doublePrecision().notNull().default(0),
}, (t) => [primaryKey({ columns: [t.workspaceId, t.period, t.metric] })]);
