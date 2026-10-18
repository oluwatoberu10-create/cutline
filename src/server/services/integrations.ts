import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { agentDeployments, channels, connections, credentials, oauthStates } from "@/db/schema";
import type { AgentConfig } from "@/lib/blueprint/schema";
import { generateToken, hashToken } from "@/lib/crypto";
import { errorMessage, forbidden, notConfigured, notFound, validationError } from "@/lib/errors";
import { env } from "../env";
import { googleAccessToken } from "../google-auth";
import { DriveClient, parseFolderLink } from "../providers/gdrive";
import { AnthropicLlm, MockLlm, OpenAiLlm, ProviderError, type LlmProvider } from "../providers/llm";
import { mockLlmResponder, mockTranscriptScript } from "../providers/mock";
import { DeepgramTranscription, MockTranscription, OpenAiTranscription, type TranscriptionProvider } from "../providers/transcription";
import {
  YouTubeApi, authorizationUrl, exchangeCode, pkcePair, revokeToken, scopeNames, type OAuthTokens,
} from "../providers/youtube";
import { decrypt, encrypt, readCredential, storeCredential, updateCredential } from "../secrets";
import { defaultDriverId, driver, makeS3Driver, storageKey, type S3Secret, type S3Settings } from "../storage";
import type { WorkspaceCtx } from "../tenancy";
import { auditWs, audit } from "./audit";

export type Connection = typeof connections.$inferSelect;
export type IntegrationKind = Connection["kind"];

/** Public view of a connection: never includes credential material. */
export function publicConnection(c: Connection) {
  return {
    id: c.id, kind: c.kind, provider: c.provider, label: c.label, status: c.status, shared: c.workspaceId === null,
    externalAccountId: c.externalAccountId, externalAccountName: c.externalAccountName, scopes: c.scopes,
    config: c.config, lastCheckedAt: c.lastCheckedAt, lastError: c.lastError, createdAt: c.createdAt,
  };
}

export const PROVIDERS: Record<IntegrationKind, { id: string; label: string; secret: "api_key" | "oauth" | "s3" | "none"; mockOnly?: boolean }[]> = {
  llm: [{ id: "anthropic", label: "Anthropic (Claude)", secret: "api_key" }, { id: "openai", label: "OpenAI", secret: "api_key" }, { id: "mock", label: "Mock LLM (tests only)", secret: "none", mockOnly: true }],
  transcription: [{ id: "openai", label: "OpenAI Whisper", secret: "api_key" }, { id: "deepgram", label: "Deepgram", secret: "api_key" }, { id: "mock", label: "Mock transcription (tests only)", secret: "none", mockOnly: true }],
  storage: [{ id: "s3", label: "S3-compatible bucket", secret: "s3" }],
  youtube: [{ id: "google", label: "YouTube (Google OAuth)", secret: "oauth" }],
};

/* ── listing ──────────────────────────────────────────────────────────── */

/** The workspace's own connections plus agency-shared ones it is allowed to use. */
export async function listConnections(ws: WorkspaceCtx, conn: DbOrTx = db): Promise<Connection[]> {
  const rows = await conn.select().from(connections).where(and(
    eq(connections.orgId, ws.orgId), isNull(connections.revokedAt),
    ws.settings.allowAgencyProviders ? or(eq(connections.workspaceId, ws.workspaceId), isNull(connections.workspaceId)) : eq(connections.workspaceId, ws.workspaceId),
  ));
  // Storage and YouTube connections are never shared across clients.
  return rows.filter((c) => c.workspaceId === ws.workspaceId || c.kind === "llm" || c.kind === "transcription");
}

export async function listOrgConnections(orgId: string) {
  return db.select().from(connections).where(and(eq(connections.orgId, orgId), isNull(connections.workspaceId), isNull(connections.revokedAt)));
}

async function loadConnection(ws: WorkspaceCtx, id: string, conn: DbOrTx = db): Promise<Connection> {
  const c = (await listConnections(ws, conn)).find((x) => x.id === id);
  if (!c) throw notFound("Connection not found.");
  return c;
}

/* ── creating ─────────────────────────────────────────────────────────── */

export async function addApiKeyConnection(scope: { orgId: string; workspaceId: string | null; actorId: string | null }, input: { kind: "llm" | "transcription"; provider: string; label: string; apiKey?: string; model?: string }) {
  const def = PROVIDERS[input.kind].find((p) => p.id === input.provider);
  if (!def) throw validationError("Unsupported provider.");
  if (def.mockOnly && !env.mockProviders()) throw forbidden("Mock providers are only available in test environments.");
  const key = (input.apiKey ?? "").trim();
  if (def.secret === "api_key" && (key.length < 16 || key.length > 400 || /\s/.test(key))) throw validationError("That does not look like a valid API key.");

  return db.transaction(async (tx) => {
    const credentialId = def.secret === "api_key" ? await storeCredential(tx, { orgId: scope.orgId, workspaceId: scope.workspaceId, kind: "api_key", secret: { apiKey: key } }) : null;
    const [row] = await tx.insert(connections).values({
      orgId: scope.orgId, workspaceId: scope.workspaceId, kind: input.kind, provider: input.provider,
      label: input.label.trim().slice(0, 80) || def.label, config: input.model ? { model: input.model } : {},
      credentialId, status: "pending", createdBy: scope.actorId,
      externalAccountName: def.secret === "api_key" ? `…${key.slice(-4)}` : null,
    }).returning();
    await audit({ orgId: scope.orgId, workspaceId: scope.workspaceId, actorId: scope.actorId, action: "integration.connect", entityType: "connection", entityId: row.id, summary: `Added ${def.label}${scope.workspaceId ? "" : " (agency-shared)"}` }, tx);
    return row;
  });
}

export async function addS3Connection(ws: WorkspaceCtx, input: S3Settings & S3Secret & { label: string }) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw validationError("Invalid bucket name.");
  if (input.endpoint && !/^https:\/\//.test(input.endpoint) && env.isProduction()) throw validationError("Storage endpoints must use HTTPS.");
  return db.transaction(async (tx) => {
    const credentialId = await storeCredential(tx, { orgId: ws.orgId, workspaceId: ws.workspaceId, kind: "s3", secret: { accessKeyId: input.accessKeyId.trim(), secretAccessKey: input.secretAccessKey.trim() } });
    const [row] = await tx.insert(connections).values({
      orgId: ws.orgId, workspaceId: ws.workspaceId, kind: "storage", provider: "s3", label: input.label || `S3 ${input.bucket}`, status: "pending",
      config: { bucket: input.bucket, region: input.region || "us-east-1", endpoint: input.endpoint || null, forcePathStyle: Boolean(input.forcePathStyle) },
      credentialId, createdBy: ws.actorId, externalAccountName: input.bucket,
    }).returning();
    await auditWs(ws, { action: "integration.connect", entityType: "connection", entityId: row.id, summary: `Connected S3 bucket ${input.bucket}` }, tx);
    return row;
  });
}

/* ── YouTube OAuth ────────────────────────────────────────────────────── */

export const OAUTH_REDIRECT_PATH = "/api/oauth/google/callback";

export async function startYouTubeOAuth(ws: WorkspaceCtx, scopes: string[], returnTo: string): Promise<string> {
  const google = env.google();
  if (!google) throw notConfigured("YouTube is not set up on this installation. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (see docs/INTEGRATIONS.md).");
  if (!ws.actorId) throw forbidden();
  const wanted = [...new Set(["youtube.readonly", ...scopes])].filter((s) => ["youtube.readonly", "yt-analytics.readonly", "youtube.upload", "youtube.force-ssl"].includes(s));
  const state = generateToken(32);
  const { verifier, challenge } = pkcePair();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await db.insert(oauthStates).values({
    stateHash: hashToken(state), workspaceId: ws.workspaceId, userId: ws.actorId, provider: "google",
    codeVerifierCiphertext: encrypt(verifier), scopes: wanted, returnTo, expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return authorizationUrl({ clientId: google.clientId, redirectUri: env.appUrl() + OAUTH_REDIRECT_PATH, state, challenge, scopes: wanted });
}

/**
 * Completes the OAuth flow. The state must exist, be unexpired, and belong to
 * the same signed-in user who started it; it is single-use.
 */
export async function completeYouTubeOAuth(userId: string, state: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ workspaceId: string | null; returnTo: string; channelTitle: string }> {
  const google = env.google();
  if (!google) throw notConfigured("Google OAuth is not configured.");
  const [row] = await db.delete(oauthStates).where(eq(oauthStates.stateHash, hashToken(state))).returning();
  if (!row || row.expiresAt < new Date()) throw validationError("This sign-in link has expired. Start the connection again.");
  if (row.userId !== userId) throw forbidden("This sign-in was started by a different user.");

  const tokens = await exchangeCode({ clientId: google.clientId, clientSecret: google.clientSecret, redirectUri: env.appUrl() + OAUTH_REDIRECT_PATH, code, verifier: decrypt(row.codeVerifierCiphertext) }, fetchImpl);
  if (!tokens.refresh_token) throw validationError("Google did not return a refresh token. Remove the app's access in your Google account settings and connect again.");
  if (row.provider === "google_drive") {
    const label = await completeDrive(row, userId, tokens, fetchImpl);
    return { workspaceId: row.workspaceId, returnTo: row.returnTo, channelTitle: label };
  }
  if (!row.workspaceId) throw validationError("This YouTube sign-in is not linked to a workspace.");
  const api = new YouTubeApi({ kind: "oauth", token: async () => tokens.access_token }, fetchImpl);
  const chans = await api.myChannels();
  if (!chans.length) throw validationError("That Google account has no YouTube channel.");
  const channel = chans[0];
  const granted = scopeNames(tokens.scope);

  const { systemWorkspace } = await import("../tenancy");
  const ws = { ...(await systemWorkspace(row.workspaceId)), actorId: userId };
  await db.transaction(async (tx) => {
    // Reconnecting the same channel replaces the old credential instead of duplicating it.
    const existing = (await tx.select().from(connections).where(and(eq(connections.workspaceId, ws.workspaceId), eq(connections.kind, "youtube"), eq(connections.externalAccountId, channel.id), isNull(connections.revokedAt))))[0];
    let connectionId: string;
    if (existing?.credentialId) {
      await updateCredential(tx, existing.credentialId, tokens);
      await tx.update(connections).set({ status: "connected", scopes: granted, lastError: null, lastCheckedAt: new Date(), externalAccountName: channel.title }).where(eq(connections.id, existing.id));
      connectionId = existing.id;
    } else {
      const credentialId = await storeCredential(tx, { orgId: ws.orgId, workspaceId: ws.workspaceId, kind: "oauth_tokens", secret: tokens });
      const [c] = await tx.insert(connections).values({
        orgId: ws.orgId, workspaceId: ws.workspaceId, kind: "youtube", provider: "google", label: channel.title, status: "connected",
        externalAccountId: channel.id, externalAccountName: channel.title, scopes: granted, credentialId, createdBy: userId, lastCheckedAt: new Date(),
      }).returning();
      connectionId = c.id;
    }
    await tx.insert(channels).values({
      workspaceId: ws.workspaceId, source: "oauth", connectionId, youtubeChannelId: channel.id, title: channel.title, handle: channel.handle,
      description: channel.description, thumbnailUrl: channel.thumbnail, subscriberCount: channel.subscribers, videoCount: channel.videos,
      viewCount: channel.views, uploadsPlaylistId: channel.uploadsPlaylistId, isPrimary: true,
    }).onConflictDoUpdate({ target: [channels.workspaceId, channels.youtubeChannelId], set: { source: "oauth", connectionId, title: channel.title, isPrimary: true } });
    await auditWs(ws, { action: "integration.connect", entityType: "connection", entityId: connectionId, summary: `Connected YouTube channel "${channel.title}"`, metadata: { scopes: granted } }, tx);
  });
  return { workspaceId: row.workspaceId, returnTo: row.returnTo, channelTitle: channel.title };
}

/* ── Google Drive (media storage) ─────────────────────────────────────── */

/**
 * Starts connecting Google Drive as media storage — for one workspace, or for
 * the whole agency when `workspaceId` is null (the default for every client
 * without storage of its own). With a folder link, full Drive access is
 * requested so Cutline can write into that existing folder; without one, only
 * `drive.file` is requested and Cutline creates its own folder.
 */
export async function startDriveOAuth(scope: { orgId: string; workspaceId: string | null; actorId: string | null }, folderLink: string, returnTo: string): Promise<string> {
  const google = env.google();
  if (!google) throw notConfigured("Google sign-in is not set up on this installation. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.");
  if (!scope.actorId) throw forbidden();
  const folderId = folderLink.trim() ? parseFolderLink(folderLink) : null;
  if (folderLink.trim() && !folderId) throw validationError("That does not look like a Google Drive folder link. Open the folder in Drive and copy the address (…/drive/folders/…).");
  const scopes = [folderId ? "drive" : "drive.file"];
  const state = generateToken(32);
  const { verifier, challenge } = pkcePair();
  await db.delete(oauthStates).where(lt(oauthStates.expiresAt, new Date()));
  await db.insert(oauthStates).values({
    stateHash: hashToken(state), workspaceId: scope.workspaceId, orgId: scope.orgId, userId: scope.actorId, provider: "google_drive",
    codeVerifierCiphertext: encrypt(verifier), scopes, options: { folderId }, returnTo, expiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });
  return authorizationUrl({ clientId: google.clientId, redirectUri: env.appUrl() + OAUTH_REDIRECT_PATH, state, challenge, scopes });
}

async function completeDrive(row: typeof oauthStates.$inferSelect, userId: string, tokens: OAuthTokens, fetchImpl: typeof fetch): Promise<string> {
  const client = new DriveClient(async () => tokens.access_token, fetchImpl);
  const chosen = (row.options as { folderId?: string | null }).folderId ?? null;
  let orgId = row.orgId, wsName: string | null = null;
  if (row.workspaceId) {
    const { systemWorkspace } = await import("../tenancy");
    const w = await systemWorkspace(row.workspaceId);
    orgId = w.orgId; wsName = w.workspaceName;
  }
  if (!orgId) throw validationError("This Drive sign-in is not linked to an agency.");
  let folder: { id: string; name: string };
  if (chosen) {
    const f = await client.folder(chosen);
    if (!f.canAdd) throw validationError(`You can view “${f.name}” but not add files to it. Ask its owner for edit access, or use another folder.`);
    folder = f;
  } else {
    folder = await client.createFolder(wsName ? `Cutline Media – ${wsName}` : "Cutline Media");
  }
  const email = await client.accountEmail().catch(() => null);
  const label = `Google Drive · ${folder.name}`;
  await db.transaction(async (tx) => {
    const credentialId = await storeCredential(tx, { orgId: orgId!, workspaceId: row.workspaceId, kind: "oauth_tokens", secret: tokens });
    const [c] = await tx.insert(connections).values({
      orgId: orgId!, workspaceId: row.workspaceId, kind: "storage", provider: "google_drive", label, status: "connected",
      externalAccountId: folder.id, externalAccountName: email ?? folder.name, scopes: row.scopes, config: { folderId: folder.id, folderName: folder.name },
      credentialId, createdBy: userId, lastCheckedAt: new Date(),
    }).returning();
    await audit({ orgId: orgId!, workspaceId: row.workspaceId, actorId: userId, action: "integration.connect", entityType: "connection", entityId: c.id, summary: `Connected ${label}${row.workspaceId ? "" : " as the agency's default media storage"}` }, tx);
  });
  return label;
}

/** The agency's default Drive, used by workspaces without storage of their own. */
async function agencyStorage(orgId: string): Promise<Connection | null> {
  const [c] = await db.select().from(connections).where(and(eq(connections.orgId, orgId), isNull(connections.workspaceId), eq(connections.kind, "storage"), isNull(connections.revokedAt)))
    .orderBy(desc(connections.createdAt)).limit(1);
  return c ?? null;
}

const storageId = (c: Connection) => (c.provider === "google_drive" ? `gdrive:${c.id}` : `s3:${c.id}`);

/** A valid access token for a YouTube connection, refreshing it when close to expiry. */
const youtubeAccessToken = (c: Connection, fetchImpl: typeof fetch = fetch) => googleAccessToken(c, fetchImpl);

/* ── resolution: logical refs → this workspace's providers ────────────── */

async function deploymentBindings(ws: WorkspaceCtx): Promise<Record<string, string>> {
  const [d] = await db.select({ bindings: agentDeployments.bindings }).from(agentDeployments).where(eq(agentDeployments.workspaceId, ws.workspaceId)).limit(1);
  return (d?.bindings ?? {}) as Record<string, string>;
}

/** The connection bound to `ref`, else the first usable one of that kind. */
export async function resolveConnection(ws: WorkspaceCtx, ref: string | null, kind: IntegrationKind, provider?: string): Promise<Connection | null> {
  const all = (await listConnections(ws)).filter((c) => c.kind === kind && c.status !== "revoked" && (!provider || c.provider === provider))
    .filter((c) => c.provider !== "mock" || env.mockProviders());
  if (ref) {
    const bound = (await deploymentBindings(ws))[ref];
    if (bound) {
      const c = all.find((x) => x.id === bound);
      if (c) return c;
    }
  }
  // Prefer the workspace's own connection over an agency-shared one.
  return all.find((c) => c.workspaceId === ws.workspaceId) ?? all[0] ?? null;
}

export async function getLlm(ws: WorkspaceCtx, prefs: AgentConfig["models"]["llm"]): Promise<LlmProvider> {
  for (const pref of prefs.preferences) {
    const c = await resolveConnection(ws, prefs.ref, "llm", pref.provider);
    const model = ((c?.config as { model?: string } | undefined)?.model) || pref.model;
    if (c?.credentialId) {
      const { apiKey } = await readCredential<{ apiKey: string }>(c.credentialId);
      return pref.provider === "anthropic" ? new AnthropicLlm(apiKey, model) : new OpenAiLlm(apiKey, model);
    }
    if (ws.settings.allowAgencyProviders) {
      const key = pref.provider === "anthropic" ? env.anthropicKey() : env.openaiKey();
      if (key) return pref.provider === "anthropic" ? new AnthropicLlm(key, pref.model) : new OpenAiLlm(key, pref.model);
    }
  }
  if (env.mockProviders() && await resolveConnection(ws, prefs.ref, "llm", "mock")) return new MockLlm(mockLlmResponder);
  throw notConfigured(`No language model is configured for this workspace. Add an ${prefs.preferences.map((p) => p.provider === "anthropic" ? "Anthropic" : "OpenAI").join(" or ")} API key under Integrations${ws.settings.allowAgencyProviders ? " (or set it installation-wide in the environment)" : ""}.`);
}

export async function getTranscriber(ws: WorkspaceCtx, prefs: AgentConfig["models"]["transcription"]): Promise<TranscriptionProvider> {
  for (const pref of prefs.preferences) {
    const c = await resolveConnection(ws, prefs.ref, "transcription", pref.provider);
    const model = ((c?.config as { model?: string } | undefined)?.model) || pref.model;
    let key: string | null = null;
    if (c?.credentialId) key = (await readCredential<{ apiKey: string }>(c.credentialId)).apiKey;
    else if (ws.settings.allowAgencyProviders) key = pref.provider === "openai" ? env.openaiKey() : env.deepgramKey();
    if (key) return pref.provider === "openai" ? new OpenAiTranscription(key, model) : new DeepgramTranscription(key, model);
  }
  if (env.mockProviders() && await resolveConnection(ws, prefs.ref, "transcription", "mock")) return new MockTranscription(mockTranscriptScript);
  throw notConfigured("No speech-to-text provider is configured for this workspace. Add an OpenAI (Whisper) or Deepgram API key under Integrations.");
}

export async function getYouTube(ws: WorkspaceCtx, fetchImpl: typeof fetch = fetch): Promise<{ api: YouTubeApi; connection: Connection; scopes: string[] }> {
  const c = await resolveConnection(ws, "youtube_connection", "youtube");
  if (!c) throw notConfigured("No YouTube channel is connected to this workspace. Connect one under Integrations → YouTube.");
  if (c.status === "error") throw notConfigured(c.lastError ?? "The YouTube connection needs to be reconnected.");
  return { api: new YouTubeApi({ kind: "oauth", token: () => youtubeAccessToken(c, fetchImpl) }, fetchImpl), connection: c, scopes: c.scopes };
}

export function publicYouTube(fetchImpl: typeof fetch = fetch): YouTubeApi {
  const key = env.youtubeApiKey();
  if (!key) throw notConfigured("Public channel lookup needs YOUTUBE_API_KEY set on the installation. Alternatively connect the channel with OAuth.");
  return new YouTubeApi({ kind: "key", key }, fetchImpl);
}

/** Where new media for this workspace is stored: its bound bucket, else the installation default. */
export async function storageDriverIdFor(ws: WorkspaceCtx): Promise<string> {
  const own = await resolveConnection(ws, "media_storage", "storage");
  if (own) return storageId(own);
  const shared = await agencyStorage(ws.orgId);
  return shared ? storageId(shared) : defaultDriverId();
}

/* ── testing & disconnecting ──────────────────────────────────────────── */

export type CheckResult = { ok: boolean; message: string; details?: Record<string, unknown> };

export async function testConnection(ws: WorkspaceCtx, id: string): Promise<CheckResult> {
  const c = await loadConnection(ws, id);
  const result = await runConnectionCheck(ws, c);
  await db.update(connections).set({ status: result.ok ? "connected" : "error", lastError: result.ok ? null : result.message, lastCheckedAt: new Date() }).where(eq(connections.id, c.id));
  return result;
}

async function runConnectionCheck(ws: WorkspaceCtx, c: Connection): Promise<CheckResult> {
  try {
    if (c.provider === "mock") return { ok: env.mockProviders(), message: env.mockProviders() ? "Mock provider (test environment only)." : "Mock providers are disabled." };
    if (c.kind === "youtube") {
      const { api } = await getYouTube(ws);
      const chans = await api.myChannels();
      return { ok: chans.length > 0, message: chans.length ? `Authorised for "${chans[0].title}". Scopes: ${c.scopes.join(", ")}` : "No channel on this account.", details: { scopes: c.scopes } };
    }
    if (c.kind === "storage") {
      const d = c.provider === "google_drive" ? await driver(storageId(c)) : makeS3Driver(`s3:${c.id}`, c.config as S3Settings, await readCredential<S3Secret>(c.credentialId!));
      const key = storageKey(ws.workspaceId, "uploads", randomUUID(), "healthcheck.txt");
      const dir = join(env.scratchDir(), "checks");
      await mkdir(dir, { recursive: true });
      const p = join(dir, `${randomUUID()}.txt`);
      await writeFile(p, "ok");
      await d.putFile(key, p, "text/plain");
      const size = await d.size(key);
      await d.delete(key);
      return { ok: size === 2, message: "Wrote, read and deleted a test object." };
    }
    const { apiKey } = await readCredential<{ apiKey: string }>(c.credentialId!);
    if (c.provider === "anthropic") {
      try {
        await new Anthropic({ apiKey, maxRetries: 0 }).models.list({ limit: 1 });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) return { ok: false, message: `Anthropic rejected this API key (it is invalid, revoked or mistyped — stored key ends “${c.externalAccountName?.replace("…", "") ?? "?"}”). Disconnect it and add a key from console.anthropic.com → API keys.` };
        throw e;
      }
      return { ok: true, message: "Anthropic accepted the key." };
    }
    if (c.provider === "openai") {
      const r = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` } });
      return { ok: r.ok, message: r.ok ? "OpenAI accepted the key." : r.status === 401 ? "OpenAI rejected this API key (invalid or revoked). Disconnect it and add a key from platform.openai.com → API keys." : `OpenAI returned ${r.status}.` };
    }
    if (c.provider === "deepgram") {
      const r = await fetch("https://api.deepgram.com/v1/projects", { headers: { authorization: `Token ${apiKey}` } });
      return { ok: r.ok, message: r.ok ? "Deepgram accepted the key." : r.status === 401 || r.status === 403 ? "Deepgram rejected this API key. Disconnect it and add a key from console.deepgram.com." : `Deepgram returned ${r.status}.` };
    }
    return { ok: false, message: "No check available for this provider." };
  } catch (err) {
    return { ok: false, message: err instanceof ProviderError || err instanceof Error ? errorMessage(err) : "Check failed." };
  }
}

/** Revokes upstream where possible, destroys the stored credential and marks the connection revoked. */
export async function disconnect(ws: WorkspaceCtx, id: string): Promise<{ upstreamRevoked: boolean }> {
  const c = await loadConnection(ws, id);
  if (c.workspaceId === null) throw forbidden("Agency-shared integrations are managed from the agency Integrations page.");
  let upstreamRevoked = false;
  if ((c.kind === "youtube" || c.provider === "google_drive") && c.credentialId) {
    try {
      const t = await readCredential<OAuthTokens>(c.credentialId);
      upstreamRevoked = await revokeToken(t.refresh_token ?? t.access_token);
    } catch { /* still remove locally */ }
  }
  await db.transaction(async (tx) => {
    await tx.update(connections).set({ status: "revoked", revokedAt: new Date(), credentialId: null }).where(eq(connections.id, c.id));
    if (c.credentialId) await tx.delete(credentials).where(eq(credentials.id, c.credentialId));
    await auditWs(ws, { action: "integration.disconnect", entityType: "connection", entityId: c.id, summary: `Disconnected ${c.label}`, metadata: { upstreamRevoked } }, tx);
  });
  return { upstreamRevoked };
}

export async function disconnectShared(orgId: string, actorId: string, id: string): Promise<void> {
  const [c] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.orgId, orgId), isNull(connections.workspaceId))).limit(1);
  if (!c) throw notFound("Connection not found.");
  if (c.provider === "google_drive" && c.credentialId) {
    try { const t = await readCredential<OAuthTokens>(c.credentialId); await revokeToken(t.refresh_token ?? t.access_token); } catch { /* still remove locally */ }
  }
  await db.transaction(async (tx) => {
    await tx.update(connections).set({ status: "revoked", revokedAt: new Date(), credentialId: null }).where(eq(connections.id, c.id));
    if (c.credentialId) await tx.delete(credentials).where(eq(credentials.id, c.credentialId));
    await audit({ orgId, actorId, action: "integration.disconnect", entityType: "connection", entityId: c.id, summary: `Removed agency-shared ${c.label}` }, tx);
  });
}

export async function testSharedConnection(orgId: string, id: string): Promise<CheckResult> {
  const [c] = await db.select().from(connections).where(and(eq(connections.id, id), eq(connections.orgId, orgId), isNull(connections.workspaceId))).limit(1);
  if (!c) throw notFound("Connection not found.");
  const fakeWs = { workspaceId: "00000000-0000-0000-0000-000000000000", orgId, settings: { allowAgencyProviders: true } } as WorkspaceCtx;
  const result = await runConnectionCheck(fakeWs, c);
  await db.update(connections).set({ status: result.ok ? "connected" : "error", lastError: result.ok ? null : result.message, lastCheckedAt: new Date() }).where(eq(connections.id, c.id));
  return result;
}

/** Storage driver for a given asset row (installation default or the client's bucket). */
export { driver as storageDriver };
