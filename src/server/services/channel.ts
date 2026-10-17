import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { channelAnalyses, channelSnapshots, channels, playlists, videos } from "@/db/schema";
import { AppError, errorMessage, notConfigured, notFound } from "@/lib/errors";
import { hypothesesOutput } from "../ai/schemas";
import { ProviderError } from "../providers/llm";
import { YouTubeApi, type YtVideo } from "../providers/youtube";
import type { WorkspaceCtx } from "../tenancy";
import { effectiveConfig } from "./agent-config";
import { auditWs } from "./audit";
import { getYouTube, publicYouTube } from "./integrations";
import { callLlm } from "./llm-call";
import { getProfile } from "./workspaces";

export type Access = Record<string, { available: boolean; reason: string }>;

export async function primaryChannel(ws: WorkspaceCtx) {
  const rows = await db.select().from(channels).where(eq(channels.workspaceId, ws.workspaceId)).orderBy(desc(channels.isPrimary), desc(channels.createdAt));
  return rows[0] ?? null;
}

/** Adds a channel by public URL/handle for research when OAuth is not available. */
export async function addPublicChannel(ws: WorkspaceCtx, input: string, fetchImpl: typeof fetch = fetch) {
  const ch = await publicYouTube(fetchImpl).publicChannel(input);
  if (!ch) throw new AppError("VALIDATION_ERROR", "No public channel found for that URL or handle. Use a youtube.com/@handle or /channel/UC… address.");
  const hasPrimary = Boolean(await primaryChannel(ws));
  const [row] = await db.insert(channels).values({
    workspaceId: ws.workspaceId, source: "public", youtubeChannelId: ch.id, title: ch.title, handle: ch.handle, description: ch.description,
    thumbnailUrl: ch.thumbnail, subscriberCount: ch.subscribers, videoCount: ch.videos, viewCount: ch.views, uploadsPlaylistId: ch.uploadsPlaylistId, isPrimary: !hasPrimary,
  }).onConflictDoUpdate({ target: [channels.workspaceId, channels.youtubeChannelId], set: { title: ch.title } }).returning();
  await auditWs(ws, { action: "channel.add_public", entityType: "channel", entityId: row.id, summary: `Added public channel "${ch.title}"` });
  return row;
}

/**
 * Pulls channel, uploads, playlists and — when authorised — per-video
 * analytics. Records which data was and was not available, and why.
 */
export async function syncChannel(ws: WorkspaceCtx, opts: { maxVideos: number }, fetchImpl: typeof fetch = fetch) {
  const ch = await primaryChannel(ws);
  let api: YouTubeApi;
  let oauthScopes: string[] = [];
  if (ch?.source === "oauth" || !ch) {
    const yt = await getYouTube(ws, fetchImpl).catch((e) => { if (ch) throw e; throw notConfigured("Connect a YouTube channel (OAuth) or add a public channel URL first."); });
    api = yt.api;
    oauthScopes = yt.scopes;
  } else {
    api = publicYouTube(fetchImpl);
  }

  const access: Access = {};
  const info = ch?.source === "public" ? await api.publicChannel(ch.youtubeChannelId) : (await api.myChannels()).find((c) => !ch || c.id === ch.youtubeChannelId) ?? null;
  if (!info) throw notFound("The channel could not be found on YouTube.");
  access.channel = { available: true, reason: "YouTube Data API channels.list" };

  const ids = info.uploadsPlaylistId ? await api.uploadedVideoIds(info.uploadsPlaylistId, opts.maxVideos) : [];
  const vids: YtVideo[] = ids.length ? await api.videos(ids) : [];
  access.videos = { available: true, reason: `${vids.length} uploads via playlistItems.list + videos.list` };

  let pls: { id: string; title: string; itemCount: number | null }[] = [];
  try {
    pls = await api.playlists(ch?.source === "public" ? { channelId: info.id } : { mine: true });
    access.playlists = { available: true, reason: `${pls.length} playlists` };
  } catch (e) {
    access.playlists = { available: false, reason: errorMessage(e) };
  }

  let analytics = new Map<string, Record<string, number>>();
  if (ch?.source === "public") {
    access.analytics = { available: false, reason: "Analytics are private to the channel owner; connect the channel with OAuth and grant YouTube Analytics access." };
  } else if (!oauthScopes.includes("yt-analytics.readonly")) {
    access.analytics = { available: false, reason: "The connection was not granted the yt-analytics.readonly scope. Reconnect with Analytics enabled." };
  } else {
    try {
      const end = new Date().toISOString().slice(0, 10);
      const start = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
      analytics = await api.videoAnalytics(start, end);
      access.analytics = { available: true, reason: `Per-video metrics for the last 365 days (${analytics.size} videos with data).` };
    } catch (e) {
      access.analytics = { available: false, reason: errorMessage(e) };
    }
  }
  access.demographics = { available: false, reason: "Audience demographics are not requested by this version." };
  access.comments = { available: false, reason: "Comments are not collected." };
  access.transcripts = { available: false, reason: "The YouTube API only allows caption downloads for videos the authorised account owns, with an extra scope; they are not collected." };

  const result = await db.transaction(async (tx) => {
    const [channel] = await tx.insert(channels).values({
      workspaceId: ws.workspaceId, source: ch?.source ?? "oauth", connectionId: ch?.connectionId ?? null, youtubeChannelId: info.id, title: info.title,
      handle: info.handle, description: info.description, thumbnailUrl: info.thumbnail, subscriberCount: info.subscribers, videoCount: info.videos,
      viewCount: info.views, uploadsPlaylistId: info.uploadsPlaylistId, isPrimary: true, lastSyncedAt: new Date(), access,
    }).onConflictDoUpdate({
      target: [channels.workspaceId, channels.youtubeChannelId],
      set: { title: info.title, handle: info.handle, description: info.description, thumbnailUrl: info.thumbnail, subscriberCount: info.subscribers, videoCount: info.videos, viewCount: info.views, uploadsPlaylistId: info.uploadsPlaylistId, lastSyncedAt: new Date(), access },
    }).returning();

    for (const v of vids) {
      const row = {
        workspaceId: ws.workspaceId, channelId: channel.id, youtubeVideoId: v.id, title: v.title, description: v.description.slice(0, 5000),
        publishedAt: v.publishedAt ? new Date(v.publishedAt) : null, durationSeconds: v.durationSeconds, thumbnailUrl: v.thumbnail, tags: v.tags.slice(0, 50),
        categoryId: v.categoryId, privacyStatus: v.privacyStatus, viewCount: v.views, likeCount: v.likes, commentCount: v.comments,
        analytics: analytics.get(v.id) ?? null, updatedAt: new Date(),
      };
      await tx.insert(videos).values(row).onConflictDoUpdate({ target: [videos.workspaceId, videos.youtubeVideoId], set: row });
    }
    for (const p of pls) {
      await tx.insert(playlists).values({ workspaceId: ws.workspaceId, channelId: channel.id, youtubePlaylistId: p.id, title: p.title, itemCount: p.itemCount })
        .onConflictDoUpdate({ target: [playlists.workspaceId, playlists.youtubePlaylistId], set: { title: p.title, itemCount: p.itemCount } });
    }
    await tx.insert(channelSnapshots).values({ workspaceId: ws.workspaceId, channelId: channel.id, stats: { subscribers: info.subscribers, videos: info.videos, views: info.views, synced: vids.length }, access });
    return channel;
  });
  return { channelId: result.id, videosSynced: vids.length, analyticsAvailable: access.analytics.available, access };
}

/* ── measured analysis ────────────────────────────────────────────────── */

const STOP = new Set("a an the and or but of to in on for with at by from is are was were be been it its this that these those how what why when who your you my me we our i vs versus do does did can will just about into out up not no new best top ever full part video videos".split(" "));

function terms(title: string): string[] {
  const words = title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const bigrams = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return [...new Set([...words, ...bigrams])];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type V = typeof videos.$inferSelect;

export function measureChannel(vs: V[], profile: { niche: string; contentCategories: string[]; goals: string }, now = Date.now()) {
  const withViews = vs.filter((v) => v.viewCount != null);
  const med = median(withViews.map((v) => v.viewCount!));
  const ageDays = (v: V) => Math.max(1, (now - (v.publishedAt?.getTime() ?? now)) / 864e5);
  const perDay = (v: V) => (v.viewCount ?? 0) / ageDays(v);
  const shorts = vs.filter((v) => (v.durationSeconds ?? 0) > 0 && v.durationSeconds! <= 60);
  const longs = vs.filter((v) => (v.durationSeconds ?? 0) > 60);

  const termStats = new Map<string, { count: number; views: number[] }>();
  for (const v of vs) for (const t of terms(v.title)) {
    const s = termStats.get(t) ?? { count: 0, views: [] };
    s.count++;
    if (v.viewCount != null) s.views.push(v.viewCount);
    termStats.set(t, s);
  }
  const topics = [...termStats.entries()].filter(([, s]) => s.count >= 2)
    .map(([term, s]) => ({ term, videos: s.count, medianViews: median(s.views), vsChannelMedian: med ? Math.round((median(s.views) / med) * 100) / 100 : null }))
    .sort((a, b) => b.videos - a.videos || (b.vsChannelMedian ?? 0) - (a.vsChannelMedian ?? 0)).slice(0, 20);

  const recent = [...vs].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)).slice(0, 20);
  const recentTerms = new Map<string, number>();
  for (const v of recent) for (const t of terms(v.title)) recentTerms.set(t, (recentTerms.get(t) ?? 0) + 1);
  const repeated = [...recentTerms.entries()].filter(([, n]) => recent.length >= 5 && n / recent.length >= 0.3).map(([term, n]) => ({ term, inLastUploads: n, of: recent.length }));

  const months = new Map<string, number>();
  for (const v of vs) if (v.publishedAt) { const k = v.publishedAt.toISOString().slice(0, 7); months.set(k, (months.get(k) ?? 0) + 1); }

  const goalTerms = terms(`${profile.niche} ${profile.contentCategories.join(" ")} ${profile.goals}`).filter((t) => !t.includes(" "));
  const recentText = recent.map((v) => v.title.toLowerCase()).join(" ");
  const goalCoverage = goalTerms.slice(0, 20).map((t) => ({ term: t, inRecentTitles: recentText.includes(t) }));

  const pick = (v: V) => ({ youtubeId: v.youtubeVideoId, title: v.title, views: v.viewCount, viewsPerDay: Math.round(perDay(v) * 10) / 10, durationSeconds: v.durationSeconds, publishedAt: v.publishedAt?.toISOString() ?? null, avgViewPercentage: (v.analytics as Record<string, number> | null)?.averageViewPercentage ?? null });

  return {
    videoCount: vs.length,
    medianViews: med,
    medianDurationSeconds: median(vs.map((v) => v.durationSeconds ?? 0).filter(Boolean)),
    uploadsByMonth: [...months.entries()].sort().slice(-12).map(([month, count]) => ({ month, count })),
    formatMix: { shorts: { count: shorts.length, medianViews: median(shorts.map((v) => v.viewCount ?? 0)) }, long: { count: longs.length, medianViews: median(longs.map((v) => v.viewCount ?? 0)) } },
    topByViews: [...withViews].sort((a, b) => b.viewCount! - a.viewCount!).slice(0, 8).map(pick),
    topByViewsPerDay: [...withViews].sort((a, b) => perDay(b) - perDay(a)).slice(0, 8).map(pick),
    followUpCandidates: withViews.filter((v) => med > 0 && v.viewCount! >= med * 2).sort((a, b) => b.viewCount! - a.viewCount!).slice(0, 8).map(pick),
    shortsCandidates: longs.filter((v) => med > 0 && (v.viewCount ?? 0) >= med * 1.5).slice(0, 8).map(pick),
    topics,
    repeatedRecently: repeated,
    goalCoverage,
    analyticsVideos: vs.filter((v) => v.analytics).length,
  };
}

export type Measured = ReturnType<typeof measureChannel>;

export async function analyzeChannel(ws: WorkspaceCtx, opts: { useLlm: boolean }) {
  const ch = await primaryChannel(ws);
  if (!ch) throw notConfigured("No channel yet. Connect a channel or add a public channel URL, then sync it.");
  const vs = await db.select().from(videos).where(and(eq(videos.workspaceId, ws.workspaceId), eq(videos.channelId, ch.id)));
  if (!vs.length) throw notConfigured("The channel has no synced videos yet. Run a channel sync first.");
  const profile = await getProfile(ws);
  const measured = measureChannel(vs, profile);

  let hypotheses: unknown = null, provider: string | null = null, model: string | null = null, isMock = false;
  let llmNote: string | null = null;
  if (opts.useLlm) {
    const { config } = await effectiveConfig(ws);
    try {
      const out = await callLlm(ws, config, {
        schemaName: "channel_hypotheses", schema: hypothesesOutput,
        instructions: config.instructions.channelAnalysis,
        task: "Analyse this YouTube channel. Measured statistics are provided and are factual. Produce hypotheses (clearly framed as such) about what resonates, gaps, overused topics, follow-ups, shorts opportunities, audience questions, series ideas and gaps against the creator's goals. Cite only videoIds from the provided list. Do not predict views or promise outcomes.",
        data: {
          creatorProfile: { niche: profile.niche, audience: profile.targetAudience, problems: profile.audienceProblems, goals: profile.goals, formats: profile.formats, avoid: profile.avoidTopics },
          measured,
          videos: [...vs].sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0)).slice(0, config.modules.ideation.maxVideosInContext)
            .map((v) => ({ youtubeId: v.youtubeVideoId, title: v.title, views: v.viewCount, durationSeconds: v.durationSeconds, publishedAt: v.publishedAt?.toISOString().slice(0, 10) })),
        },
      });
      const known = new Set(vs.map((v) => v.youtubeVideoId));
      hypotheses = { summary: out.data.summary, items: out.data.hypotheses.map((h) => ({ ...h, videoIds: h.videoIds.filter((id) => known.has(id)) })) };
      provider = out.provider; model = out.model; isMock = out.isMock;
    } catch (e) {
      if (e instanceof AppError && (e.code === "NOT_CONFIGURED" || e.code === "PLAN_LIMIT_REACHED")) llmNote = e.message;
      else if (e instanceof ProviderError && !e.retryable) llmNote = e.message;
      else throw e;
    }
  }
  const [row] = await db.insert(channelAnalyses).values({
    workspaceId: ws.workspaceId, channelId: ch.id, measured: { ...measured, llmNote }, hypotheses, provider, model, isMock,
  }).returning();
  return { analysisId: row.id, hasHypotheses: hypotheses !== null, llmNote };
}

export async function latestAnalysis(ws: WorkspaceCtx) {
  const [row] = await db.select().from(channelAnalyses).where(eq(channelAnalyses.workspaceId, ws.workspaceId)).orderBy(desc(channelAnalyses.createdAt)).limit(1);
  return row ?? null;
}

export async function channelVideos(ws: WorkspaceCtx, limit = 200) {
  return db.select().from(videos).where(eq(videos.workspaceId, ws.workspaceId)).orderBy(desc(videos.publishedAt)).limit(limit);
}

export async function videosByYoutubeIds(ws: WorkspaceCtx, ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(videos).where(and(eq(videos.workspaceId, ws.workspaceId), inArray(videos.youtubeVideoId, ids)));
}

export async function workspacePlaylists(ws: WorkspaceCtx) {
  return db.select().from(playlists).where(eq(playlists.workspaceId, ws.workspaceId)).orderBy(playlists.title);
}
