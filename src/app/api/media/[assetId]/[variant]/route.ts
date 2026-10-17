import { Readable } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, renderJobs } from "@/db/schema";
import { driver, verifyMediaSignature } from "@/server/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serves stored media through short-lived signed URLs (the signature binds
 * workspace + asset + variant + expiry). Supports HTTP Range so browsers can
 * seek in video. The asset must belong to the signed workspace.
 */
export async function GET(req: Request, { params }: { params: Promise<{ assetId: string; variant: string }> }) {
  const { assetId, variant } = await params;
  const url = new URL(req.url);
  const w = url.searchParams.get("w") ?? "", exp = url.searchParams.get("exp") ?? "", sig = url.searchParams.get("sig") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(assetId) || !/^[0-9a-f-]{36}$/.test(w)) return new Response("Not found", { status: 404 });
  if (!verifyMediaSignature(w, assetId, variant, exp, sig)) return new Response("Link expired or invalid", { status: 403 });

  const [a] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.workspaceId, w), isNull(mediaAssets.deletedAt))).limit(1);
  if (!a) return new Response("Not found", { status: 404 });

  let key: string | null = null, type = a.mimeType, filename = a.originalFilename;
  if (variant === "original") key = a.storageKey;
  else if (variant === "proxy") { key = a.proxyKey; type = "video/mp4"; }
  else if (variant === "thumb") { key = a.thumbnailKey; type = a.kind === "image" ? a.mimeType : "image/jpeg"; }
  else if (variant === "audio") { key = a.audioKey; type = "audio/mpeg"; }
  else if (variant === "captions") {
    const [r] = await db.select({ k: renderJobs.captionsKey }).from(renderJobs).where(and(eq(renderJobs.outputAssetId, a.id), eq(renderJobs.workspaceId, w))).limit(1);
    key = r?.k ?? null; type = "application/x-subrip"; filename = filename.replace(/\.[^.]+$/, ".srt");
  }
  if (!key) return new Response("Not available", { status: 404 });

  const d = await driver(a.storageDriver);
  const size = await d.size(key);
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  const headers: Record<string, string> = {
    "content-type": type, "accept-ranges": "bytes", "cache-control": "private, max-age=600",
    "content-disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${filename.replace(/[^\w.\- ]+/g, "_")}"`,
    "x-content-type-options": "nosniff",
  };
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const stream = await d.readStream(key, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) } });
  }
  const stream = await d.readStream(key);
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { ...headers, "content-length": String(size) } });
}
