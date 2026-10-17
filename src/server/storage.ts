import "server-only";
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { connections } from "@/db/schema";
import { notConfigured, validationError } from "@/lib/errors";
import { env } from "./env";
import { readCredential, sign, verifySignature } from "./secrets";

/**
 * Media storage.
 *
 * Keys are generated server-side only (`ws/<workspace>/<area>/<id>/<file>`) and
 * validated against a strict pattern before touching any backend, so user
 * input can never become a path. The local driver additionally checks the
 * resolved path stays inside its root.
 *
 * `storageDriver` on each asset row records where it lives:
 *   "local" · "s3"  (installation default from env) · "s3:<connectionId>" (client-owned bucket)
 */

const KEY_RE = /^ws\/[0-9a-f-]{36}\/(assets|renders|uploads|captions)\/[0-9a-f-]{36}\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function storageKey(workspaceId: string, area: "assets" | "renders" | "uploads" | "captions", id: string, file: string): string {
  const key = `ws/${workspaceId}/${area}/${id}/${file}`;
  assertKey(key);
  return key;
}

function assertKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..")) throw validationError("Invalid storage key.");
}

export interface StorageDriver {
  readonly id: string;
  putFile(key: string, path: string, contentType: string): Promise<void>;
  /** Makes the object available as a local file (direct path for local storage, a download otherwise). */
  toLocalFile(key: string, scratchPath: string): Promise<string>;
  readStream(key: string, range?: { start: number; end: number }): Promise<Readable>;
  size(key: string): Promise<number>;
  delete(key: string): Promise<void>;
  /** A direct, time-limited URL when the backend supports one. */
  presign(key: string, seconds: number, filename?: string): Promise<string | null>;
}

class LocalDriver implements StorageDriver {
  readonly id = "local";
  private root = resolve(env.storage().localDir);

  path(key: string): string {
    assertKey(key);
    const p = resolve(this.root, ...key.split("/"));
    if (!p.startsWith(this.root + sep)) throw validationError("Invalid storage key.");
    return p;
  }

  async putFile(key: string, path: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    try { await rename(path, dest); } catch { await copyFile(path, dest); await rm(path, { force: true }); }
  }

  async toLocalFile(key: string): Promise<string> {
    return this.path(key);
  }

  async readStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    return createReadStream(this.path(key), range);
  }

  async size(key: string): Promise<number> {
    return (await stat(this.path(key))).size;
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }

  async presign(): Promise<string | null> {
    return null;
  }
}

class S3Driver implements StorageDriver {
  constructor(readonly id: string, private client: S3Client, private bucket: string) {}

  async putFile(key: string, path: string, contentType: string): Promise<void> {
    assertKey(key);
    const size = (await stat(path)).size;
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: createReadStream(path), ContentLength: size, ContentType: contentType }));
    await rm(path, { force: true });
  }

  async toLocalFile(key: string, scratchPath: string): Promise<string> {
    assertKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    await mkdir(dirname(scratchPath), { recursive: true });
    await pipeline(res.Body as Readable, createWriteStream(scratchPath));
    return scratchPath;
  }

  async readStream(key: string, range?: { start: number; end: number }): Promise<Readable> {
    assertKey(key);
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range ? `bytes=${range.start}-${range.end}` : undefined }));
    return res.Body as Readable;
  }

  async size(key: string): Promise<number> {
    assertKey(key);
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.ContentLength ?? 0;
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presign(key: string, seconds: number, filename?: string): Promise<string> {
    assertKey(key);
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: key,
      ResponseContentDisposition: filename ? `inline; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"` : undefined,
    }), { expiresIn: seconds });
  }
}

export type S3Settings = { bucket: string; region: string; endpoint?: string | null; forcePathStyle?: boolean };
export type S3Secret = { accessKeyId: string; secretAccessKey: string };

export function makeS3Driver(id: string, cfg: S3Settings, secret: S3Secret): StorageDriver {
  const client = new S3Client({
    region: cfg.region, endpoint: cfg.endpoint ?? undefined, forcePathStyle: cfg.forcePathStyle ?? false,
    credentials: { accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey },
  });
  return new S3Driver(id, client, cfg.bucket);
}

let local: LocalDriver | null = null;
let envS3: StorageDriver | null = null;

export function localDriver(): LocalDriver {
  return (local ??= new LocalDriver());
}

/** The installation default, from STORAGE_DRIVER. */
export function defaultDriverId(): string {
  return env.storage().driver === "s3" ? "s3" : "local";
}

export async function driver(id: string): Promise<StorageDriver> {
  if (id === "local") {
    if (env.onVercel()) throw notConfigured("Media storage is not configured. Vercel has no persistent disk: set STORAGE_DRIVER=s3 with S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (any S3-compatible service, e.g. Cloudflare R2), or connect a bucket in the workspace's Integrations.");
    return localDriver();
  }
  if (id === "s3") {
    if (envS3) return envS3;
    const s = env.storage().s3;
    if (!s.bucket || !s.accessKeyId || !s.secretAccessKey) throw notConfigured("STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
    return (envS3 = makeS3Driver("s3", { bucket: s.bucket, region: s.region, endpoint: s.endpoint, forcePathStyle: s.forcePathStyle }, { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey }));
  }
  const m = /^s3:([0-9a-f-]{36})$/.exec(id);
  if (!m) throw new Error(`Unknown storage driver "${id}".`);
  const [conn] = await db.select().from(connections).where(and(eq(connections.id, m[1]), isNull(connections.revokedAt))).limit(1);
  if (!conn?.credentialId) throw notConfigured("The storage connection for this media has been removed.");
  return makeS3Driver(id, conn.config as S3Settings, await readCredential<S3Secret>(conn.credentialId));
}

/* ── signed URLs served by /api/media ─────────────────────────────────── */

export type MediaVariant = "original" | "proxy" | "thumb" | "audio" | "captions";

export function signedMediaPath(workspaceId: string, assetId: string, variant: MediaVariant, seconds = 3600): string {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  const sig = sign(`${workspaceId}:${assetId}:${variant}:${exp}`);
  return `/api/media/${assetId}/${variant}?w=${workspaceId}&exp=${exp}&sig=${sig}`;
}

export function verifyMediaSignature(workspaceId: string, assetId: string, variant: string, exp: string, sig: string): boolean {
  const e = Number(exp);
  if (!Number.isFinite(e) || e < Date.now() / 1000) return false;
  return verifySignature(`${workspaceId}:${assetId}:${variant}:${e}`, sig);
}
