import "server-only";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { credentials } from "@/db/schema";

/**
 * Encryption for stored secrets (OAuth tokens, API keys, upload session URIs).
 *
 * AES-256-GCM with a random 96-bit IV per value. Format: v1.<iv>.<tag>.<ciphertext>
 * (base64url). The key comes from CUTLINE_ENCRYPTION_KEY (32 bytes, base64) and
 * never leaves the server. This module is the only place plaintext secrets exist.
 */

function key(): Buffer {
  const raw = process.env.CUTLINE_ENCRYPTION_KEY;
  if (!raw) throw new Error("CUTLINE_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("CUTLINE_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return buf;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unrecognised secret format.");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export async function storeCredential(conn: DbOrTx, opts: { orgId: string; workspaceId: string | null; kind: string; secret: unknown }): Promise<string> {
  const [row] = await conn.insert(credentials).values({
    orgId: opts.orgId, workspaceId: opts.workspaceId, kind: opts.kind, ciphertext: encrypt(JSON.stringify(opts.secret)),
  }).returning({ id: credentials.id });
  return row.id;
}

export async function updateCredential(conn: DbOrTx, id: string, secret: unknown): Promise<void> {
  await conn.update(credentials).set({ ciphertext: encrypt(JSON.stringify(secret)), rotatedAt: new Date() }).where(eq(credentials.id, id));
}

/**
 * Reads a credential. Callers must already have resolved the credential
 * through a workspace-scoped connection — this function does no tenancy
 * check of its own, which is why only provider resolution code calls it.
 */
export async function readCredential<T>(id: string, conn: DbOrTx = db): Promise<T> {
  const [row] = await conn.select({ ciphertext: credentials.ciphertext }).from(credentials).where(eq(credentials.id, id)).limit(1);
  if (!row) throw new Error("Credential not found.");
  return JSON.parse(decrypt(row.ciphertext)) as T;
}

/* ── signed media URLs ────────────────────────────────────────────────── */

function signingKey(): string {
  const s = process.env.CUTLINE_SIGNING_SECRET;
  if (!s || s.length < 32) throw new Error("CUTLINE_SIGNING_SECRET must be set to at least 32 characters.");
  return s;
}

export function sign(value: string): string {
  return createHmac("sha256", signingKey()).update(value).digest("base64url");
}

export function verifySignature(value: string, sig: string): boolean {
  const expected = Buffer.from(sign(value));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
