/**
 * In-memory Google Drive v3 (the endpoints Cutline uses): folders, files.list
 * by name+parent, resumable uploads with ordered Content-Range chunks,
 * alt=media downloads with Range, delete, about. Non-Drive requests are passed
 * to `fallback` (e.g. the fake Google token endpoint).
 */
type File = { id: string; name: string; parent: string | null; folder: boolean; data: Uint8Array; canAdd: boolean };

export function createFakeDrive(fallback: typeof fetch) {
  const files = new Map<string, File>();
  const sessions = new Map<string, { name: string; parent: string; total: number; got: Uint8Array[]; received: number; fileId?: string }>();
  let n = 0;
  const id = () => `f${String(++n).padStart(6, "0")}xxxxxx`;
  const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  const bytes = (b: unknown) => (b instanceof Uint8Array ? b : typeof b === "string" ? new TextEncoder().encode(b) : new Uint8Array(0));

  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const h = new Headers(init?.headers);
    const isDrive = url.host === "www.googleapis.com" && (url.pathname.startsWith("/drive/v3") || url.pathname.startsWith("/upload/drive/v3"));
    if (!isDrive) return fallback(input as string, init);
    if (!h.get("authorization")?.startsWith("Bearer ")) return json({ error: { message: "Login required" } }, 401);

    if (url.pathname === "/drive/v3/about") return json({ user: { emailAddress: "owner@drive.test" } });
    if (url.pathname === "/drive/v3/files" && method === "POST") {
      const b = JSON.parse(String(init?.body));
      const f: File = { id: id(), name: b.name, parent: null, folder: true, data: new Uint8Array(0), canAdd: true };
      files.set(f.id, f);
      return json({ id: f.id, name: f.name });
    }
    if (url.pathname === "/drive/v3/files" && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const hit = [...files.values()].find((f) => !f.folder && f.name === name && f.parent === parent);
      return json({ files: hit ? [{ id: hit.id, size: String(hit.data.byteLength) }] : [] });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return json({ error: { message: "File not found", errors: [{ reason: "notFound" }] } }, 404);
      if (method === "DELETE") { files.delete(f.id); return new Response(null, { status: 204 }); }
      if (url.searchParams.get("alt") === "media") {
        const r = /bytes=(\d+)-(\d+)/.exec(h.get("range") ?? "");
        const body = r ? f.data.slice(Number(r[1]), Number(r[2]) + 1) : f.data;
        return new Response(body as BodyInit, { status: r ? 206 : 200 });
      }
      return json({ id: f.id, name: f.name, mimeType: f.folder ? "application/vnd.google-apps.folder" : "video/mp4", capabilities: { canAddChildren: f.canAdd } });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "POST") {
      const b = JSON.parse(String(init?.body));
      const parent = files.get(b.parents[0]);
      if (!parent?.folder) return json({ error: { message: "parent not found" } }, 404);
      const sid = `s${++n}`;
      sessions.set(sid, { name: b.name, parent: b.parents[0], total: Number(h.get("x-upload-content-length")), got: [], received: 0 });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
    }
    if (url.pathname === "/upload/drive/v3/files" && method === "PUT") {
      const s = sessions.get(url.searchParams.get("upload_id") ?? "");
      if (!s) return json({ error: { message: "session expired" } }, 404);
      const cr = h.get("content-range") ?? "";
      const done = () => json({ id: s.fileId, size: String(s.total) }, 200);
      if (cr === "bytes */0" && s.total === 0 && !s.fileId) {
        const f: File = { id: id(), name: s.name, parent: s.parent, folder: false, data: new Uint8Array(0), canAdd: false };
        files.set(f.id, f); s.fileId = f.id;
      }
      if (cr.startsWith("bytes */")) return s.fileId ? done() : new Response(null, { status: 308, headers: s.received ? { range: `bytes=0-${s.received - 1}` } : {} });
      if (!/bytes (\d+)-(\d+)\/(\d+)/.test(cr)) return json({ error: { message: `bad Content-Range "${cr}"` } }, 400);
      const r = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr)!;
      if (Number(r[1]) !== s.received) return json({ error: { message: "out of order" } }, 400);
      const chunk = bytes(init?.body);
      s.got.push(chunk); s.received += chunk.byteLength;
      if (s.received >= s.total) {
        const data = new Uint8Array(s.total); let o = 0; for (const c of s.got) { data.set(c, o); o += c.byteLength; }
        const f: File = { id: id(), name: s.name, parent: s.parent, folder: false, data, canAdd: false };
        files.set(f.id, f); s.fileId = f.id;
        return done();
      }
      return new Response(null, { status: 308, headers: { range: `bytes=0-${s.received - 1}` } });
    }
    return json({ error: { message: `fake drive: unhandled ${method} ${url.pathname}` } }, 404);
  };

  /** A folder the user "shares" with Cutline via a link. */
  const addFolder = (name: string, canAdd = true) => { const f: File = { id: id(), name, parent: null, folder: true, data: new Uint8Array(0), canAdd }; files.set(f.id, f); return f.id; };
  return { fetch: fetchImpl as typeof fetch, files, addFolder };
}
