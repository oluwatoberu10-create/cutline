"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/field";
import { ProgressBar } from "./ui/kit";

type Item = { key: string; name: string; size: number; progress: number; status: "queued" | "uploading" | "done" | "error"; error?: string };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.success) throw new Error(j?.error?.message ?? `Request failed (${res.status})`);
  return j.data as T;
}

/**
 * Chunked, resumable uploads through /api/v1. Each part is retried; after a
 * reload the same file resumes from the parts the server already holds.
 */
export function Uploader({ wsId, projects, ideaId, maxMb }: { wsId: string; projects: { id: string; title: string }[]; ideaId?: string; maxMb: number }) {
  const router = useRouter();
  const [items, setItems] = React.useState<Item[]>([]);
  const [role, setRole] = React.useState("source");
  const [projectId, setProjectId] = React.useState("");
  const [recordedAt, setRecordedAt] = React.useState("");
  const [drag, setDrag] = React.useState(false);
  const base = `/api/v1/workspaces/${wsId}`;
  const set = (key: string, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const upload = async (file: File) => {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    setItems((xs) => [...xs.filter((x) => x.key !== key), { key, name: file.name, size: file.size, progress: 0, status: "uploading" }]);
    try {
      if (file.size > maxMb * 1024 * 1024) throw new Error(`Larger than this workspace's ${maxMb} MB limit.`);
      const resumeKey = `cl-upload:${wsId}:${key}`;
      let session: { uploadId: string; chunkBytes: number; totalParts: number } | null = null;
      let have = new Set<number>();
      try {
        const saved = localStorage.getItem(resumeKey);
        if (saved) {
          const s = JSON.parse(saved);
          const st = await api<{ status: string; receivedParts: number[] }>(`${base}/uploads/${s.uploadId}`);
          if (st.status === "open") { session = s; have = new Set(st.receivedParts); }
        }
      } catch { /* start fresh */ }
      if (!session) {
        session = await api(`${base}/uploads`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: file.name, size: file.size, role, projectId: projectId || null, recordedAt: recordedAt || null }) });
        try { localStorage.setItem(resumeKey, JSON.stringify(session)); } catch {}
      }
      const s = session!;
      let done = have.size;
      for (let p = 1; p <= s.totalParts; p++) {
        if (have.has(p)) continue;
        const blob = file.slice((p - 1) * s.chunkBytes, p * s.chunkBytes);
        for (let attempt = 1; ; attempt++) {
          try { await api(`${base}/uploads/${s.uploadId}/parts/${p}`, { method: "PUT", body: blob, headers: { "content-type": "application/octet-stream" } }); break; }
          catch (e) { if (attempt >= 4) throw e; await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); }
        }
        done++;
        set(key, { progress: (done / s.totalParts) * 97 });
      }
      await api(`${base}/uploads/${s.uploadId}/complete`, { method: "POST" });
      try { localStorage.removeItem(resumeKey); } catch {}
      set(key, { progress: 100, status: "done" });
      router.refresh();
    } catch (e) {
      set(key, { status: "error", error: (e as Error).message });
    }
  };

  const onFiles = (files: FileList | null) => { if (files) for (const f of Array.from(files)) void upload(f); };

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Kind of file">
          <option value="source">Raw recording (video or audio)</option><option value="brand">Logo / brand image</option><option value="intro">Intro clip</option><option value="outro">Outro clip</option>
        </Select>
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project"><option value="">No project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</Select>
        <Input type="date" value={recordedAt} onChange={(e) => setRecordedAt(e.target.value)} aria-label="Recording date" />
      </div>
      <label onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); onFiles(e.dataTransfer.files); }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-[var(--radius-card)] border-2 border-dashed px-6 py-8 text-center transition-colors ${drag ? "border-[var(--brand)] bg-[var(--brand-soft)]" : "border-[var(--border-strong)] hover:bg-[var(--surface-2)]"}`}>
        <span className="text-[14px] font-semibold">Drop files or click to upload</span>
        <span className="mt-1 text-[12.5px] text-[var(--text-muted)]">Video, audio or images up to {maxMb >= 1024 ? `${Math.round(maxMb / 1024)} GB` : `${maxMb} MB`}. Large files upload in parts and resume if interrupted.{ideaId ? " Linked to the selected idea." : ""}</span>
        <input type="file" multiple className="sr-only" accept="video/*,audio/*,image/png,image/jpeg,image/webp,.mkv,.mts,.m2ts,.mxf" onChange={(e) => onFiles(e.target.files)} />
      </label>
      {items.length > 0 && (
        <ul className="space-y-2">{items.map((i) => (
          <li key={i.key} className="rounded-[var(--radius-field)] border border-[var(--border)] p-3">
            <div className="flex items-center justify-between gap-2 text-[13px]"><span className="truncate font-medium">{i.name}</span><span className="text-[var(--text-muted)]">{i.status === "done" ? "Uploaded — processing" : i.status === "error" ? "Failed" : `${Math.round(i.progress)}%`}</span></div>
            <ProgressBar className="mt-2" value={i.progress} tone={i.status === "error" ? "danger" : i.status === "done" ? "success" : "brand"} />
            {i.error && <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-[var(--danger)]">{i.error}<Button size="sm" variant="ghost" type="button" onClick={() => setItems((xs) => xs.filter((x) => x.key !== i.key))}>Dismiss</Button></div>}
          </li>
        ))}</ul>
      )}
    </div>
  );
}
