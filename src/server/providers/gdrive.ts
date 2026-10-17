import "server-only";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ProviderError } from "./llm";

/**
 * Google Drive v3 as a media store. Every stored object is one Drive file in a
 * single folder, named after its storage key (slashes become "__"), so keys
 * stay globally unique and lookups are a single query.
 *
 * Scopes: `drive.file` (Cutline only sees files it created — it makes its own
 * "Cutline Media" folder), or full `drive` when the user supplies an existing
 * folder link.
 */

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const ALL = "supportsAllDrives=true";

export const DRIVE_SCOPE_FILE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_SCOPE_FULL = "https://www.googleapis.com/auth/drive";

/** Extracts a folder id from a Drive folder link or a bare id. */
export function parseFolderLink(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s) ?? /^([A-Za-z0-9_-]{10,})$/.exec(s);
  return m ? m[1] : null;
}

export const driveName = (key: string) => key.replace(/\//g, "__");

export class DriveClient {
  constructor(private token: () => Promise<string>, private fetchImpl: typeof fetch = fetch) {}

  private async req(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await this.token()}`);
    return this.fetchImpl(url, { ...init, headers });
  }

  private async json<T>(url: string, init?: RequestInit): Promise<T> {
    const res = await this.req(url, init);
    if (!res.ok) throw await driveError(res);
    return res.json() as Promise<T>;
  }

  async folder(id: string): Promise<{ id: string; name: string; canAdd: boolean }> {
    const f = await this.json<{ id: string; name: string; mimeType: string; capabilities?: { canAddChildren?: boolean } }>(`${API}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,capabilities(canAddChildren)&${ALL}`);
    if (f.mimeType !== "application/vnd.google-apps.folder") throw new ProviderError("That Drive link is not a folder.", false);
    return { id: f.id, name: f.name, canAdd: f.capabilities?.canAddChildren !== false };
  }

  async accountEmail(): Promise<string | null> {
    const j = await this.json<{ user?: { emailAddress?: string } }>(`${API}/about?fields=user(emailAddress)`);
    return j.user?.emailAddress ?? null;
  }

  async createFolder(name: string): Promise<{ id: string; name: string }> {
    return this.json(`${API}/files?fields=id,name&${ALL}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }),
    });
  }

  async find(folderId: string, name: string): Promise<{ id: string; size: number } | null> {
    const q = `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed = false`;
    const j = await this.json<{ files?: { id: string; size?: string }[] }>(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,size)&pageSize=1&includeItemsFromAllDrives=true&${ALL}`);
    const f = j.files?.[0];
    return f ? { id: f.id, size: Number(f.size ?? 0) } : null;
  }

  /** Starts a resumable upload; returns the session URI (a bearer capability — store encrypted). */
  async startUpload(folderId: string, name: string, size: number, mime: string): Promise<string> {
    const res = await this.req(`${UPLOAD}/files?uploadType=resumable&fields=id,size&${ALL}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, "x-upload-content-length": String(size) },
      body: JSON.stringify({ name, parents: [folderId] }),
    });
    if (!res.ok) throw await driveError(res);
    const loc = res.headers.get("location");
    if (!loc) throw new ProviderError("Google Drive did not return an upload session.", true);
    return loc;
  }

  /** Sends bytes [offset, offset+len) of a total; returns the file id once the upload is complete. */
  async putChunk(session: string, body: Uint8Array, offset: number, total: number): Promise<{ done: boolean; received: number; fileId?: string }> {
    const end = offset + body.byteLength - 1;
    const res = await this.req(session, { method: "PUT", headers: { "content-length": String(body.byteLength), "content-range": `bytes ${offset}-${end}/${total}` }, body: body as BodyInit });
    if (res.status === 308) return { done: false, received: rangeEnd(res.headers.get("range")) };
    if (res.status === 200 || res.status === 201) return { done: true, received: total, fileId: ((await res.json()) as { id: string }).id };
    throw await driveError(res);
  }

  /** How many bytes Drive already holds for a session (for resuming). */
  async sessionStatus(session: string, total: number): Promise<{ done: boolean; received: number; fileId?: string }> {
    const res = await this.req(session, { method: "PUT", headers: { "content-length": "0", "content-range": `bytes */${total}` } });
    if (res.status === 308) return { done: false, received: rangeEnd(res.headers.get("range")) };
    if (res.status === 200 || res.status === 201) return { done: true, received: total, fileId: ((await res.json()) as { id: string }).id };
    throw await driveError(res);
  }

  /** Uploads a whole local file (8 MiB chunks, multiples of 256 KiB as Drive requires). */
  async uploadFile(folderId: string, name: string, path: string, mime: string): Promise<string> {
    const size = (await stat(path)).size;
    const session = await this.startUpload(folderId, name, size, mime);
    // A zero-byte file is finalised with "Content-Range: bytes */0" (no data range exists).
    if (size === 0) {
      const done = await this.sessionStatus(session, 0);
      if (!done.fileId) throw new ProviderError("Google Drive did not confirm the empty file.", true);
      return done.fileId;
    }
    const CHUNK = 8 * 1024 * 1024;
    let offset = 0;
    for await (const chunk of createReadStream(path, { highWaterMark: CHUNK })) {
      const buf = chunk as Buffer;
      const r = await this.putChunk(session, new Uint8Array(buf), offset, size);
      offset += buf.byteLength;
      if (r.done) return r.fileId!;
    }
    const st = await this.sessionStatus(session, size);
    if (!st.fileId) throw new ProviderError("Google Drive did not confirm the upload.", true);
    return st.fileId;
  }

  async download(fileId: string, range?: { start: number; end: number }): Promise<Readable> {
    const res = await this.req(`${API}/files/${encodeURIComponent(fileId)}?alt=media&${ALL}`, { headers: range ? { range: `bytes=${range.start}-${range.end}` } : {} });
    if (!res.ok || !res.body) throw await driveError(res);
    return Readable.fromWeb(res.body as never);
  }

  async remove(fileId: string): Promise<void> {
    const res = await this.req(`${API}/files/${encodeURIComponent(fileId)}?${ALL}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw await driveError(res);
  }
}

function rangeEnd(range: string | null): number {
  const m = /bytes=0-(\d+)/.exec(range ?? "");
  return m ? Number(m[1]) + 1 : 0;
}

async function driveError(res: Response): Promise<ProviderError> {
  let reason = "", message = "";
  try {
    const j = await res.json() as { error?: { message?: string; errors?: { reason?: string }[]; status?: string } };
    reason = j.error?.errors?.[0]?.reason ?? j.error?.status ?? "";
    message = j.error?.message ?? "";
  } catch { /* non-JSON */ }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(`${reason} ${message}`)) {
    return new ProviderError("The Google Drive API is not enabled in your Google Cloud project. Enable “Google Drive API” in Cloud Console → APIs & Services → Library, then retry.", false);
  }
  if (res.status === 401) return new ProviderError("The Google Drive authorisation expired or was revoked. Reconnect Google Drive.", false);
  if (res.status === 403 && /storageQuotaExceeded/i.test(reason)) return new ProviderError("The Google Drive is full.", false);
  if (res.status === 404) return new ProviderError("Google Drive could not find that file or folder (or Cutline has no access to it).", false);
  if (res.status === 403) return new ProviderError(`Google Drive refused the request (${reason || "forbidden"}): ${message}`.slice(0, 300), false);
  return new ProviderError(`Google Drive error ${res.status}${reason ? ` (${reason})` : ""}: ${message}`.slice(0, 300), res.status >= 500 || res.status === 429);
}
