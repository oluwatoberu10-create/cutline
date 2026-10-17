import "server-only";
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { generateToken } from "@/lib/crypto";
import { ProviderError } from "./llm";

/**
 * YouTube Data API v3, YouTube Analytics API v2 and Google OAuth 2.0.
 *
 * Only documented endpoints are used. What the APIs cannot do is reported
 * rather than faked: pinned comments cannot be pinned through the API, custom
 * thumbnails need a verified channel, captions and playlist inserts need the
 * youtube.force-ssl scope, and analytics need yt-analytics.readonly.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";

export const SCOPE_URLS: Record<string, string> = {
  "youtube.readonly": "https://www.googleapis.com/auth/youtube.readonly",
  "yt-analytics.readonly": "https://www.googleapis.com/auth/yt-analytics.readonly",
  "youtube.upload": "https://www.googleapis.com/auth/youtube.upload",
  "youtube.force-ssl": "https://www.googleapis.com/auth/youtube.force-ssl",
  "drive.file": "https://www.googleapis.com/auth/drive.file",
  drive: "https://www.googleapis.com/auth/drive",
};

export function scopeNames(granted: string): string[] {
  const urls = granted.split(/\s+/);
  return Object.entries(SCOPE_URLS).filter(([, u]) => urls.includes(u)).map(([n]) => n);
}

/* ── OAuth ────────────────────────────────────────────────────────────── */

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = generateToken(48);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizationUrl(o: { clientId: string; redirectUri: string; state: string; challenge: string; scopes: string[] }): string {
  const p = new URLSearchParams({
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code",
    scope: o.scopes.map((s) => SCOPE_URLS[s]).filter(Boolean).join(" "),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    state: o.state, code_challenge: o.challenge, code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${p}`;
}

export type OAuthTokens = { access_token: string; refresh_token?: string; expires_at: number; scope: string };

export async function exchangeCode(o: { clientId: string; clientSecret: string; redirectUri: string; code: string; verifier: string }, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, code: o.code, code_verifier: o.verifier, grant_type: "authorization_code" }),
  });
  const j = await res.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !j.access_token) throw new ProviderError(`Google sign-in failed: ${j.error_description ?? j.error ?? res.status}`, false);
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, scope: j.scope ?? "" };
}

export async function refreshAccessToken(o: { clientId: string; clientSecret: string; refreshToken: string }, fetchImpl: typeof fetch = fetch): Promise<OAuthTokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: "refresh_token" }),
  });
  const j = await res.json() as { access_token?: string; expires_in?: number; scope?: string; error?: string };
  if (j.error === "invalid_grant") throw new ReauthRequired();
  if (!res.ok || !j.access_token) throw new ProviderError(`Could not refresh the YouTube token (${j.error ?? res.status}).`, res.status >= 500);
  return { access_token: j.access_token, refresh_token: o.refreshToken, expires_at: Date.now() + (j.expires_in ?? 3600) * 1000, scope: j.scope ?? "" };
}

export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
  return res.ok;
}

export class ReauthRequired extends ProviderError {
  constructor() { super("The YouTube authorisation has expired or was revoked. Reconnect the channel.", false); }
}

/* ── API client ───────────────────────────────────────────────────────── */

export type YtChannel = { id: string; title: string; handle: string | null; description: string; thumbnail: string | null; subscribers: number | null; videos: number | null; views: number | null; uploadsPlaylistId: string | null };
export type YtVideo = { id: string; title: string; description: string; publishedAt: string | null; durationSeconds: number | null; thumbnail: string | null; tags: string[]; categoryId: string | null; privacyStatus: string | null; views: number | null; likes: number | null; comments: number | null };

type Auth = { kind: "oauth"; token: () => Promise<string> } | { kind: "key"; key: string };

export class YouTubeApi {
  constructor(private auth: Auth, private fetchImpl: typeof fetch = fetch) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    if (this.auth.kind === "key") u.searchParams.set("key", this.auth.key);
    else headers.set("authorization", `Bearer ${await this.auth.token()}`);
    return this.fetchImpl(u, { ...init, headers });
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.request(url, init);
    if (!res.ok) throw await apiError(res);
    return res.json() as Promise<T>;
  }

  async myChannels(): Promise<YtChannel[]> {
    const j = await this.json<{ items?: RawChannel[] }>(`${API}/channels?part=snippet,contentDetails,statistics&mine=true&maxResults=50`);
    return (j.items ?? []).map(mapChannel);
  }

  /** Public lookup by @handle, channel id or channel URL. */
  async publicChannel(input: string): Promise<YtChannel | null> {
    const ref = parseChannelRef(input);
    if (!ref) return null;
    const q = ref.kind === "id" ? `id=${encodeURIComponent(ref.value)}` : `forHandle=${encodeURIComponent(ref.value)}`;
    const j = await this.json<{ items?: RawChannel[] }>(`${API}/channels?part=snippet,contentDetails,statistics&${q}`);
    return j.items?.[0] ? mapChannel(j.items[0]) : null;
  }

  async uploadedVideoIds(uploadsPlaylistId: string, max: number): Promise<string[]> {
    const ids: string[] = [];
    let page: string | undefined;
    while (ids.length < max) {
      const j = await this.json<{ items?: { contentDetails?: { videoId?: string } }[]; nextPageToken?: string }>(
        `${API}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploadsPlaylistId)}${page ? `&pageToken=${page}` : ""}`);
      for (const it of j.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
      if (!j.nextPageToken) break;
      page = j.nextPageToken;
    }
    return ids.slice(0, max);
  }

  async videos(ids: string[]): Promise<YtVideo[]> {
    const out: YtVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const j = await this.json<{ items?: RawVideo[] }>(`${API}/videos?part=snippet,contentDetails,statistics,status&id=${ids.slice(i, i + 50).join(",")}`);
      out.push(...(j.items ?? []).map(mapVideo));
    }
    return out;
  }

  async playlists(opts: { mine: true } | { channelId: string }): Promise<{ id: string; title: string; itemCount: number | null }[]> {
    const q = "mine" in opts ? "mine=true" : `channelId=${encodeURIComponent(opts.channelId)}`;
    const j = await this.json<{ items?: { id: string; snippet?: { title?: string }; contentDetails?: { itemCount?: number } }[] }>(`${API}/playlists?part=snippet,contentDetails&maxResults=50&${q}`);
    return (j.items ?? []).map((p) => ({ id: p.id, title: p.snippet?.title ?? "", itemCount: p.contentDetails?.itemCount ?? null }));
  }

  /** Per-video analytics for the authorised channel. Requires yt-analytics.readonly. */
  async videoAnalytics(startDate: string, endDate: string): Promise<Map<string, Record<string, number>>> {
    const metrics = "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,subscribersGained";
    const j = await this.json<{ columnHeaders?: { name: string }[]; rows?: (string | number)[][] }>(
      `${ANALYTICS}?ids=channel==MINE&startDate=${startDate}&endDate=${endDate}&metrics=${metrics}&dimensions=video&sort=-views&maxResults=200`);
    const cols = (j.columnHeaders ?? []).map((c) => c.name);
    const map = new Map<string, Record<string, number>>();
    for (const row of j.rows ?? []) {
      const rec: Record<string, number> = {};
      cols.forEach((c, i) => { if (c !== "video") rec[c] = Number(row[i]); });
      map.set(String(row[cols.indexOf("video")]), rec);
    }
    return map;
  }

  /* ── resumable upload ─────────────────────────────────────────────── */

  async startUpload(meta: { snippet: Record<string, unknown>; status: Record<string, unknown> }, size: number, contentType: string): Promise<string> {
    const res = await this.request(`${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-length": String(size), "x-upload-content-type": contentType },
      body: JSON.stringify(meta),
    });
    if (!res.ok) throw await apiError(res);
    const location = res.headers.get("location");
    if (!location) throw new ProviderError("YouTube did not return an upload session.", true);
    return location;
  }

  /** How many bytes of a resumable session YouTube already has (or the finished video). */
  async uploadStatus(sessionUri: string, size: number): Promise<{ received: number; video?: { id: string } }> {
    const res = await this.request(sessionUri, { method: "PUT", headers: { "content-range": `bytes */${size}`, "content-length": "0" } });
    if (res.status === 200 || res.status === 201) return { received: size, video: await res.json() as { id: string } };
    if (res.status === 308) return { received: rangeEnd(res.headers.get("range")) };
    if (res.status === 404 || res.status === 410) throw new UploadSessionExpired();
    throw await apiError(res);
  }

  /** Sends the file from `offset` in 8 MiB chunks (a multiple of 256 KiB, as required). */
  async uploadFrom(sessionUri: string, filePath: string, offset: number, onProgress: (bytes: number) => Promise<void> | void, signal?: AbortSignal): Promise<{ id: string }> {
    const size = (await stat(filePath)).size;
    const CHUNK = 8 * 1024 * 1024;
    const fh = await open(filePath, "r");
    try {
      let pos = offset;
      while (pos < size) {
        if (signal?.aborted) throw new Error("Cancelled");
        const len = Math.min(CHUNK, size - pos);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        const res = await this.request(sessionUri, { method: "PUT", headers: { "content-length": String(len), "content-range": `bytes ${pos}-${pos + len - 1}/${size}` }, body: buf, signal });
        if (res.status === 308) {
          pos = rangeEnd(res.headers.get("range"));
          await onProgress(pos);
          continue;
        }
        if (res.status === 200 || res.status === 201) {
          await onProgress(size);
          return await res.json() as { id: string };
        }
        if (res.status === 404 || res.status === 410) throw new UploadSessionExpired();
        throw await apiError(res);
      }
      // Everything was already sent; ask for the final resource.
      const st = await this.uploadStatus(sessionUri, size);
      if (st.video) return st.video;
      throw new ProviderError("Upload finished but YouTube has not confirmed the video.", true);
    } finally {
      await fh.close();
    }
  }

  async videoStatus(id: string): Promise<{ uploadStatus: string | null; privacyStatus: string | null; publishAt: string | null; processingStatus: string | null; failureReason: string | null; rejectionReason: string | null } | null> {
    const j = await this.json<{ items?: { status?: { uploadStatus?: string; privacyStatus?: string; publishAt?: string; failureReason?: string; rejectionReason?: string }; processingDetails?: { processingStatus?: string } }[] }>(
      `${API}/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`);
    const v = j.items?.[0];
    if (!v) return null;
    return {
      uploadStatus: v.status?.uploadStatus ?? null, privacyStatus: v.status?.privacyStatus ?? null, publishAt: v.status?.publishAt ?? null,
      processingStatus: v.processingDetails?.processingStatus ?? null, failureReason: v.status?.failureReason ?? null, rejectionReason: v.status?.rejectionReason ?? null,
    };
  }

  /** Requires youtube.force-ssl. */
  async addToPlaylist(playlistId: string, videoId: string): Promise<void> {
    await this.json(`${API}/playlistItems?part=snippet`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } } }),
    });
  }

  /** Uploads an SRT caption track. Requires youtube.force-ssl. */
  async insertCaption(videoId: string, language: string, name: string, srt: string): Promise<void> {
    const boundary = `cutline${generateToken(8)}`;
    const body = [
      `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "",
      JSON.stringify({ snippet: { videoId, language, name, isDraft: false } }),
      `--${boundary}`, "Content-Type: application/octet-stream", "", srt, `--${boundary}--`, "",
    ].join("\r\n");
    const res = await this.request(`${UPLOAD_API}/captions?uploadType=multipart&part=snippet`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
    if (!res.ok) throw await apiError(res);
  }
}

export class UploadSessionExpired extends ProviderError {
  constructor() { super("The YouTube upload session expired; a new one will be started.", true); }
}

function rangeEnd(range: string | null): number {
  const m = /bytes=0-(\d+)/.exec(range ?? "");
  return m ? Number(m[1]) + 1 : 0;
}

async function apiError(res: Response): Promise<ProviderError> {
  let reason = "", message = "";
  try {
    const j = await res.json() as { error?: { message?: string; errors?: { reason?: string }[] } };
    reason = j.error?.errors?.[0]?.reason ?? "";
    message = j.error?.message ?? "";
  } catch { /* non-JSON error body */ }
  if (res.status === 401) return new ReauthRequired();
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") return new ProviderError("The YouTube API daily quota is exhausted for this Google Cloud project. Retry after the quota resets (midnight Pacific).", false);
  if (res.status === 403) return new ProviderError(`YouTube refused the request (${reason || "forbidden"}): ${message}. The connection may be missing a required permission.`, false);
  if (reason === "uploadLimitExceeded") return new ProviderError("This channel has reached its YouTube upload limit.", false);
  return new ProviderError(`YouTube API error ${res.status}${reason ? ` (${reason})` : ""}: ${message}`.slice(0, 500), res.status >= 500 || res.status === 429);
}

/* ── parsing ──────────────────────────────────────────────────────────── */

type RawChannel = { id: string; snippet?: { title?: string; customUrl?: string; description?: string; thumbnails?: { medium?: { url?: string }; default?: { url?: string } } }; statistics?: { subscriberCount?: string; videoCount?: string; viewCount?: string; hiddenSubscriberCount?: boolean }; contentDetails?: { relatedPlaylists?: { uploads?: string } } };
type RawVideo = { id: string; snippet?: { title?: string; description?: string; publishedAt?: string; tags?: string[]; categoryId?: string; thumbnails?: { medium?: { url?: string } } }; contentDetails?: { duration?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string }; status?: { privacyStatus?: string } };

const num = (s?: string) => (s === undefined ? null : Number(s));

function mapChannel(c: RawChannel): YtChannel {
  return {
    id: c.id, title: c.snippet?.title ?? "", handle: c.snippet?.customUrl ?? null, description: c.snippet?.description ?? "",
    thumbnail: c.snippet?.thumbnails?.medium?.url ?? c.snippet?.thumbnails?.default?.url ?? null,
    subscribers: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount), videos: num(c.statistics?.videoCount), views: num(c.statistics?.viewCount),
    uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? null,
  };
}

function mapVideo(v: RawVideo): YtVideo {
  return {
    id: v.id, title: v.snippet?.title ?? "", description: v.snippet?.description ?? "", publishedAt: v.snippet?.publishedAt ?? null,
    durationSeconds: parseIsoDuration(v.contentDetails?.duration), thumbnail: v.snippet?.thumbnails?.medium?.url ?? null, tags: v.snippet?.tags ?? [],
    categoryId: v.snippet?.categoryId ?? null, privacyStatus: v.status?.privacyStatus ?? null,
    views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount),
  };
}

export function parseIsoDuration(d?: string): number | null {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? "");
  if (!m) return null;
  return (Number(m[1] ?? 0) * 86400) + (Number(m[2] ?? 0) * 3600) + (Number(m[3] ?? 0) * 60) + Number(m[4] ?? 0);
}

export function parseChannelRef(input: string): { kind: "id" | "handle"; value: string } | null {
  const s = input.trim();
  const id = /(?:^|\/channel\/)(UC[0-9A-Za-z_-]{22})(?:$|[/?#])/.exec(s);
  if (id) return { kind: "id", value: id[1] };
  const handle = /(?:^|youtube\.com\/)(@[A-Za-z0-9._-]{3,30})(?:$|[/?#])/.exec(s);
  if (handle) return { kind: "handle", value: handle[1] };
  return null;
}
