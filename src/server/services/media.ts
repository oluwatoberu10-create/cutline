import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { mediaAssets, projects, uploadSessions } from "@/db/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { env } from "../env";
import { enqueue } from "../jobs/queue";
import { assertAcceptableMedia, detectSilences, ffmpeg, probe, proxyArgs, speechAudioArgs, thumbnailArgs } from "../media/ffmpeg";
import { driver, signedMediaPath, storageKey, type MediaVariant } from "../storage";
import type { WorkspaceCtx } from "../tenancy";
import { effectiveConfig } from "./agent-config";
import { auditWs } from "./audit";
import { storageDriverIdFor } from "./integrations";

export type Asset = typeof mediaAssets.$inferSelect;

const EXT: Record<string, { kind: "video" | "audio" | "image"; mime: string }> = {
  mp4: { kind: "video", mime: "video/mp4" }, mov: { kind: "video", mime: "video/quicktime" }, m4v: { kind: "video", mime: "video/x-m4v" },
  mkv: { kind: "video", mime: "video/x-matroska" }, webm: { kind: "video", mime: "video/webm" }, avi: { kind: "video", mime: "video/x-msvideo" },
  mts: { kind: "video", mime: "video/mp2t" }, m2ts: { kind: "video", mime: "video/mp2t" }, mxf: { kind: "video", mime: "application/mxf" },
  wav: { kind: "audio", mime: "audio/wav" }, mp3: { kind: "audio", mime: "audio/mpeg" }, m4a: { kind: "audio", mime: "audio/mp4" },
  aac: { kind: "audio", mime: "audio/aac" }, flac: { kind: "audio", mime: "audio/flac" }, ogg: { kind: "audio", mime: "audio/ogg" },
  png: { kind: "image", mime: "image/png" }, jpg: { kind: "image", mime: "image/jpeg" }, jpeg: { kind: "image", mime: "image/jpeg" }, webp: { kind: "image", mime: "image/webp" },
};

/** Vercel rejects request bodies over 4.5 MB, so parts are smaller there. */
export const CHUNK_BYTES = (process.env.VERCEL ? 4 : 8) * 1024 * 1024;

export function scratch(...parts: string[]): string {
  return join(env.scratchDir(), ...parts);
}

/** Display-safe filename; never used to build a storage path. */
function cleanName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").slice(0, 200) || "upload";
}

export function extOf(name: string): string {
  return (/\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1] ?? "").toLowerCase();
}

/* ── uploads ──────────────────────────────────────────────────────────── */

export async function createUpload(ws: WorkspaceCtx, input: { filename: string; size: number; role: "source" | "brand" | "intro" | "outro"; projectId?: string | null; recordedAt?: string | null }) {
  const ext = extOf(input.filename);
  const type = EXT[ext];
  if (!type) throw validationError(`Unsupported file type ".${ext}". Upload video (mp4, mov, mkv, webm…), audio (wav, mp3, m4a…) or image (png, jpg) files.`);
  if (input.role === "brand" && type.kind !== "image") throw validationError("Brand assets must be images (PNG with transparency works best).");
  if ((input.role === "intro" || input.role === "outro") && type.kind !== "video") throw validationError("Intros and outros must be video files.");
  const maxBytes = ws.settings.limits.maxUploadMb * 1024 * 1024;
  if (!Number.isFinite(input.size) || input.size <= 0) throw validationError("Empty file.");
  if (input.size > maxBytes) throw validationError(`This workspace accepts files up to ${ws.settings.limits.maxUploadMb} MB.`);
  if (input.recordedAt && !/^\d{4}-\d{2}-\d{2}$/.test(input.recordedAt)) throw validationError("Recording date must be YYYY-MM-DD.");
  if (input.projectId) await getProject(ws, input.projectId);

  const assetId = randomUUID();
  const driverId = await storageDriverIdFor(ws);
  await driver(driverId); // fails fast with a setup message when storage is unusable
  return db.transaction(async (tx) => {
    const [asset] = await tx.insert(mediaAssets).values({
      id: assetId, workspaceId: ws.workspaceId, projectId: input.projectId ?? null, kind: type.kind, role: input.role, status: "uploading",
      originalFilename: cleanName(input.filename), mimeType: type.mime, sizeBytes: input.size, storageDriver: driverId,
      storageKey: storageKey(ws.workspaceId, "assets", assetId, `original.${ext}`), recordedAt: input.recordedAt ?? null, createdBy: ws.actorId,
    }).returning();
    const totalParts = Math.ceil(input.size / CHUNK_BYTES);
    const [session] = await tx.insert(uploadSessions).values({
      workspaceId: ws.workspaceId, assetId, totalBytes: input.size, chunkBytes: CHUNK_BYTES, totalParts, expiresAt: new Date(Date.now() + 2 * 864e5),
    }).returning();
    return { asset, uploadId: session.id, chunkBytes: CHUNK_BYTES, totalParts };
  });
}

async function getSession(ws: WorkspaceCtx, uploadId: string) {
  const [s] = await db.select().from(uploadSessions).where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.workspaceId, ws.workspaceId))).limit(1);
  if (!s) throw notFound("Upload not found.");
  if (s.status !== "open") throw conflict("This upload is already complete.");
  if (s.expiresAt < new Date()) throw validationError("This upload expired. Start it again.");
  return s;
}

export async function uploadStatus(ws: WorkspaceCtx, uploadId: string) {
  const [s] = await db.select().from(uploadSessions).where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.workspaceId, ws.workspaceId))).limit(1);
  if (!s) throw notFound("Upload not found.");
  return { status: s.status, totalParts: s.totalParts, receivedParts: [...s.receivedParts].sort((a, b) => a - b), chunkBytes: s.chunkBytes };
}

/** Stores one chunk. Idempotent: re-sending a part overwrites it, so clients can resume blindly. */
export async function receivePart(ws: WorkspaceCtx, uploadId: string, part: number, body: ReadableStream<Uint8Array> | null) {
  const s = await getSession(ws, uploadId);
  if (!Number.isInteger(part) || part < 1 || part > s.totalParts) throw validationError("Invalid part number.");
  if (!body) throw validationError("Missing chunk body.");
  const expected = part === s.totalParts ? s.totalBytes - (s.totalParts - 1) * s.chunkBytes : s.chunkBytes;
  const dir = scratch("uploads", s.id);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${part}.part.tmp`);
  let received = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > expected) controller.error(new Error("Chunk larger than declared."));
      else controller.enqueue(chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body.pipeThrough(limiter) as never), createWriteStream(tmp));
  } catch {
    await rm(tmp, { force: true });
    throw validationError("Chunk exceeded the expected size.");
  }
  if (received !== expected) { await rm(tmp, { force: true }); throw validationError(`Chunk ${part} should be ${expected} bytes, got ${received}.`); }
  const { rename } = await import("node:fs/promises");
  await rename(tmp, join(dir, `${part}.part`));
  await db.update(uploadSessions).set({ receivedParts: sql`(select array_agg(distinct x) from unnest(array_append(${uploadSessions.receivedParts}, ${part}::int)) x)` }).where(eq(uploadSessions.id, s.id));
  return { part, bytes: received };
}

export async function completeUpload(ws: WorkspaceCtx, uploadId: string) {
  const s = await getSession(ws, uploadId);
  const have = new Set(s.receivedParts);
  const missing = Array.from({ length: s.totalParts }, (_, i) => i + 1).filter((p) => !have.has(p));
  if (missing.length) throw validationError(`Missing parts: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`);

  const [asset] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, s.assetId), eq(mediaAssets.workspaceId, ws.workspaceId))).limit(1);
  if (!asset) throw notFound("Asset not found.");
  const dir = scratch("uploads", s.id);
  const assembled = join(dir, "assembled");
  const hash = createHash("sha256");
  const out = createWriteStream(assembled);
  for (let p = 1; p <= s.totalParts; p++) {
    for await (const chunk of createReadStream(join(dir, `${p}.part`))) { hash.update(chunk as Buffer); if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r())); }
  }
  await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  const size = (await stat(assembled)).size;
  if (size !== s.totalBytes) throw validationError("Assembled size does not match the declared size.");

  const d = await driver(asset.storageDriver);
  await d.putFile(asset.storageKey, assembled, asset.mimeType);
  await rm(dir, { recursive: true, force: true });
  await db.update(uploadSessions).set({ status: "complete" }).where(eq(uploadSessions.id, s.id));
  await db.update(mediaAssets).set({ status: "processing", sha256: hash.digest("hex"), sizeBytes: size }).where(eq(mediaAssets.id, asset.id));
  const job = await enqueue({ type: "media.ingest", workspaceId: ws.workspaceId, payload: { assetId: asset.id }, dedupeKey: `ingest:${asset.id}`, timeoutSeconds: 7200, createdBy: ws.actorId });
  await auditWs(ws, { action: "media.upload", entityType: "media_asset", entityId: asset.id, summary: `Uploaded "${asset.originalFilename}"` });
  return { assetId: asset.id, jobId: job.id };
}

/* ── ingest (runs in the worker) ──────────────────────────────────────── */

/**
 * Validates the stored original with FFprobe and builds working copies. A file
 * FFprobe cannot parse — or that is not the media type its extension claims —
 * is deleted from storage and the asset is marked failed.
 */
export async function ingestAsset(ws: WorkspaceCtx, assetId: string, ctx: { jobId: string; signal: AbortSignal; progress: (p: number, note?: string) => Promise<void> }) {
  const asset = await getAsset(ws, assetId);
  const d = await driver(asset.storageDriver);
  const work = scratch("jobs", ctx.jobId);
  await mkdir(work, { recursive: true });
  try {
    const original = await d.toLocalFile(asset.storageKey, join(work, `original.${extOf(asset.storageKey)}`));
    await ctx.progress(5, "Inspecting file");
    let p;
    try {
      p = await probe(original);
      assertAcceptableMedia(p, asset.kind);
    } catch (e) {
      await d.delete(asset.storageKey).catch(() => undefined);
      await db.update(mediaAssets).set({ status: "failed", error: `Rejected: ${e instanceof Error ? e.message : "unreadable media"}` }).where(eq(mediaAssets.id, asset.id));
      return { rejected: true };
    }

    const updates: Partial<Asset> = {
      probe: p.raw as object, durationSeconds: p.duration || null, width: p.width, height: p.height, fps: p.fps, hasVideo: p.hasVideo && !p.isStillImage, hasAudio: p.hasAudio,
    };
    const put = async (file: string, name: string, mime: string) => {
      const key = storageKey(ws.workspaceId, "assets", asset.id, name);
      await d.putFile(key, file, mime);
      return key;
    };

    if (asset.kind === "video") {
      await ctx.progress(10, "Creating preview copy");
      const proxy = join(work, "proxy.mp4");
      await ffmpeg(proxyArgs(original, proxy), { signal: ctx.signal, onProgress: (s) => void ctx.progress(10 + Math.min(50, (s / Math.max(1, p.duration)) * 50)) });
      updates.proxyKey = await put(proxy, "proxy.mp4", "video/mp4");
      const thumb = join(work, "thumb.jpg");
      await ffmpeg(thumbnailArgs(original, thumb, Math.min(3, p.duration / 3)), { signal: ctx.signal });
      updates.thumbnailKey = await put(thumb, "thumb.jpg", "image/jpeg");
    }
    if (asset.kind === "image") {
      updates.thumbnailKey = asset.storageKey;
    }
    if ((asset.kind === "video" || asset.kind === "audio") && p.hasAudio) {
      await ctx.progress(65, "Extracting speech audio");
      const audio = join(work, "speech.mp3");
      await ffmpeg(speechAudioArgs(original, audio), { signal: ctx.signal });
      if (asset.role === "source") {
        await ctx.progress(80, "Measuring pauses");
        const { config } = await effectiveConfig(ws);
        const r = config.modules.editing.rules;
        updates.silences = await detectSilences(audio, r.silenceNoiseDb, Math.min(r.pauseThresholdSeconds, 0.5), ctx.signal);
      }
      updates.audioKey = await put(audio, "speech.mp3", "audio/mpeg");
    }
    await db.update(mediaAssets).set({ ...updates, status: "ready", error: null }).where(eq(mediaAssets.id, asset.id));
    return { rejected: false, duration: p.duration };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/* ── queries & lifecycle ──────────────────────────────────────────────── */

export async function getAsset(ws: Pick<WorkspaceCtx, "workspaceId">, id: string): Promise<Asset> {
  const [row] = await db.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.workspaceId, ws.workspaceId), isNull(mediaAssets.deletedAt))).limit(1);
  if (!row) throw notFound("Media not found.");
  return row;
}

export async function listAssets(ws: WorkspaceCtx, opts: { role?: Asset["role"]; projectId?: string } = {}) {
  const conds = [eq(mediaAssets.workspaceId, ws.workspaceId), isNull(mediaAssets.deletedAt)];
  if (opts.role) conds.push(eq(mediaAssets.role, opts.role));
  if (opts.projectId) conds.push(eq(mediaAssets.projectId, opts.projectId));
  return db.select().from(mediaAssets).where(and(...conds)).orderBy(desc(mediaAssets.createdAt)).limit(500);
}

/** Short-lived URLs the browser can play; signed per workspace, so they never cross tenants. */
export async function mediaUrl(ws: WorkspaceCtx, asset: Asset, variant: MediaVariant): Promise<string | null> {
  const key = variant === "original" ? asset.storageKey : variant === "proxy" ? asset.proxyKey : variant === "thumb" ? asset.thumbnailKey : variant === "audio" ? asset.audioKey : null;
  if (!key) return null;
  const d = await driver(asset.storageDriver);
  return (await d.presign(key, 3600, asset.originalFilename)) ?? signedMediaPath(ws.workspaceId, asset.id, variant);
}

export async function softDeleteAsset(ws: WorkspaceCtx, id: string) {
  const asset = await getAsset(ws, id);
  await db.update(mediaAssets).set({ deletedAt: new Date(), status: "deleted" }).where(eq(mediaAssets.id, asset.id));
  await enqueue({ type: "media.purge_files", workspaceId: ws.workspaceId, payload: { assetId: asset.id }, dedupeKey: `purge-files:${asset.id}` });
  await auditWs(ws, { action: "media.delete", entityType: "media_asset", entityId: id, summary: `Deleted "${asset.originalFilename}"` });
}

export async function purgeAssetFiles(asset: Asset) {
  const d = await driver(asset.storageDriver);
  for (const key of [asset.storageKey, asset.proxyKey, asset.audioKey, asset.thumbnailKey]) {
    if (key) await d.delete(key).catch(() => undefined);
  }
}

/* ── projects ─────────────────────────────────────────────────────────── */

export async function createProject(ws: WorkspaceCtx, input: { title: string; ideaId?: string | null; recordingDate?: string | null }) {
  const title = input.title.trim().slice(0, 120);
  if (!title) throw validationError("Name the project.");
  const [row] = await db.insert(projects).values({ workspaceId: ws.workspaceId, title, ideaId: input.ideaId ?? null, recordingDate: input.recordingDate || null }).returning();
  return row;
}

export async function getProject(ws: WorkspaceCtx, id: string) {
  const [row] = await db.select().from(projects).where(and(eq(projects.id, id), eq(projects.workspaceId, ws.workspaceId))).limit(1);
  if (!row) throw notFound("Project not found.");
  return row;
}

export async function listProjects(ws: WorkspaceCtx) {
  return db.select().from(projects).where(eq(projects.workspaceId, ws.workspaceId)).orderBy(desc(projects.createdAt));
}
