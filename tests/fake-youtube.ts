/**
 * An in-memory stand-in for the Google OAuth, YouTube Data v3 and YouTube
 * Analytics v2 endpoints Cutline calls, so integration tests exercise the real
 * client code (paging, resumable uploads, error mapping) without network
 * access. Tests that use it verify our behaviour against the documented
 * protocol — not a live Google integration.
 */
export type FakeYouTube = ReturnType<typeof createFakeYouTube>;

export function createFakeYouTube(opts: { channelId?: string; videos?: number; analytics?: "ok" | "forbidden"; failUploadAtByte?: number } = {}) {
  const channelId = opts.channelId ?? "UCfakefakefakefakefake01";
  const vids = Array.from({ length: opts.videos ?? 6 }, (_, i) => ({
    id: `vid${String(i).padStart(8, "0")}`,
    title: i % 2 ? `Espresso grind size explained part ${i}` : `Beginner espresso mistakes ${i}`,
    views: 1000 * (i + 1) * (i === 3 ? 10 : 1),
    published: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString(),
    duration: i === 5 ? "PT45S" : `PT${8 + i}M${i}S`,
  }));
  const state = { uploads: 0, putCalls: 0, received: 0, totalSize: 0, videoId: null as string | null, processed: false, tokenExchanges: 0, revoked: [] as string[], failOnceAt: opts.failUploadAtByte ?? -1 };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = new Headers(init?.headers).get("authorization");

    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      state.tokenExchanges++;
      const body = new URLSearchParams(String(init?.body));
      if (body.get("grant_type") === "authorization_code" && body.get("code") === "good-code" && body.get("code_verifier")) {
        return json({ access_token: "ya29.fake-access", refresh_token: "1//0fake-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.upload" });
      }
      if (body.get("grant_type") === "refresh_token") return json({ access_token: "ya29.fake-refreshed", expires_in: 3600 });
      return json({ error: "invalid_grant" }, 400);
    }
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") { state.revoked.push(url.searchParams.get("token") ?? ""); return new Response(null, { status: 200 }); }

    if (!auth?.startsWith("Bearer ") && !url.searchParams.get("key")) return json({ error: { message: "Login required", errors: [{ reason: "required" }] } }, 401);

    if (url.host === "www.googleapis.com" && url.pathname === "/youtube/v3/channels") {
      return json({ items: [{ id: channelId, snippet: { title: "Fake Espresso Channel", customUrl: "@fakeespresso", description: "Coffee", thumbnails: { medium: { url: "https://i.ytimg.com/x.jpg" } } }, statistics: { subscriberCount: "1200", videoCount: String(vids.length), viewCount: "50000" }, contentDetails: { relatedPlaylists: { uploads: `UU${channelId.slice(2)}` } } }] });
    }
    if (url.pathname === "/youtube/v3/playlistItems" && method === "GET") {
      return json({ items: vids.map((v) => ({ contentDetails: { videoId: v.id } })) });
    }
    if (url.pathname === "/youtube/v3/videos" && method === "GET") {
      const ids = (url.searchParams.get("id") ?? "").split(",");
      if (url.searchParams.get("part")?.includes("processingDetails")) {
        return json({ items: state.videoId && ids.includes(state.videoId) ? [{ status: { uploadStatus: state.processed ? "processed" : "uploaded", privacyStatus: "private" }, processingDetails: { processingStatus: state.processed ? "succeeded" : "processing" } }] : [] });
      }
      return json({ items: vids.filter((v) => ids.includes(v.id)).map((v) => ({ id: v.id, snippet: { title: v.title, description: "d", publishedAt: v.published, tags: ["espresso"], categoryId: "26" }, contentDetails: { duration: v.duration }, statistics: { viewCount: String(v.views), likeCount: "10", commentCount: "2" }, status: { privacyStatus: "public" } })) });
    }
    if (url.pathname === "/youtube/v3/playlists") return json({ items: [{ id: "PLfakeplaylist01", snippet: { title: "Espresso basics" }, contentDetails: { itemCount: 4 } }] });
    if (url.host === "youtubeanalytics.googleapis.com") {
      if (opts.analytics === "forbidden") return json({ error: { message: "Forbidden", errors: [{ reason: "forbidden" }] } }, 403);
      return json({ columnHeaders: [{ name: "video" }, { name: "views" }, { name: "averageViewPercentage" }], rows: vids.map((v) => [v.id, v.views, 40 + vids.indexOf(v)]) });
    }

    if (url.host === "www.googleapis.com" && url.pathname === "/upload/youtube/v3/videos" && method === "POST") {
      state.uploads++;
      state.totalSize = Number(new Headers(init?.headers).get("x-upload-content-length"));
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fake${state.uploads}` } });
    }
    if (url.pathname === "/upload/youtube/v3/videos" && method === "PUT") {
      state.putCalls++;
      const range = new Headers(init?.headers).get("content-range") ?? "";
      if (range.startsWith("bytes */")) {
        if (state.videoId) return json({ id: state.videoId }, 200);
        return new Response(null, { status: 308, headers: state.received ? { range: `bytes=0-${state.received - 1}` } : {} });
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
      const [start, end, total] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (start !== state.received) return json({ error: { message: "bad offset" } }, 400);
      if (state.failOnceAt >= 0 && end >= state.failOnceAt) { state.failOnceAt = -1; return json({ error: { message: "backend error", errors: [{ reason: "backendError" }] } }, 503); }
      state.received = end + 1;
      if (state.received >= total) { state.videoId = "uploadedVid01"; return json({ id: state.videoId }, 201); }
      return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
    }
    return json({ error: { message: `fake: unhandled ${method} ${url.pathname}` } }, 404);
  };

  return { fetch: fetchImpl as typeof fetch, state, channelId, videos: vids };
}
