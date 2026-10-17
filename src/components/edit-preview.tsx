"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { clipOrderAction } from "@/server/actions/workspace";
import { ActionForm, SubmitButton } from "./ui/action-form";

type Seg = { id: string; start: number; end: number; text: string; speaker?: string };
type Range = { start: number; end: number; type: string; status: string };

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/**
 * Source preview: the proxy video, a map of what the current cut keeps and
 * removes, and the transcript. Clicking any segment or range seeks the video.
 */
export function EditPreview({ src, duration, clips, cuts, segments, outputSrc }: {
  src: string | null; duration: number; clips: { in: number; out: number }[]; cuts: Range[]; segments: Seg[]; outputSrc: string | null;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const [t, setT] = React.useState(0);
  const [view, setView] = React.useState<"source" | "output">(outputSrc ? "output" : "source");
  const [q, setQ] = React.useState("");
  const seek = (s: number) => { setView("source"); requestAnimationFrame(() => { if (ref.current) { ref.current.currentTime = s; void ref.current.play().catch(() => undefined); } }); };
  const pct = (s: number) => `${(s / Math.max(0.001, duration)) * 100}%`;
  const kept = clips.reduce((s, c) => s + c.out - c.in, 0);
  const active = segments.findIndex((s) => t >= s.start && t < s.end);
  const shown = q ? segments.filter((s) => s.text.toLowerCase().includes(q.toLowerCase())) : segments;

  return (
    <div className="space-y-3">
      <div className="flex gap-1 text-[12.5px]">
        <button type="button" onClick={() => setView("source")} className={cn("rounded-md px-2.5 py-1 font-medium", view === "source" ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--text-muted)]")}>Source preview</button>
        <button type="button" disabled={!outputSrc} onClick={() => setView("output")} className={cn("rounded-md px-2.5 py-1 font-medium disabled:opacity-40", view === "output" ? "bg-[var(--surface-3)] text-[var(--text)]" : "text-[var(--text-muted)]")}>Latest render</button>
      </div>
      <div className="overflow-hidden rounded-[var(--radius-card)] bg-black">
        {view === "output" && outputSrc ? <video key="out" src={outputSrc} controls className="aspect-video w-full" /> :
          src ? <video key="src" ref={ref} src={src} controls preload="metadata" className="aspect-video w-full" onTimeUpdate={(e) => setT(e.currentTarget.currentTime)} /> :
          <div className="flex aspect-video items-center justify-center text-[13px] text-white/60">Preview not available yet</div>}
      </div>
      <div>
        <div className="relative h-8 overflow-hidden rounded-md bg-[var(--danger-soft)]" role="img" aria-label={`Kept ${fmt(kept)} of ${fmt(duration)}`}>
          {clips.map((c, i) => <button type="button" key={i} title={`Kept ${fmt(c.in)}–${fmt(c.out)}`} onClick={() => seek(c.in)} className="absolute inset-y-0 bg-[var(--success)]/70 hover:bg-[var(--success)]" style={{ left: pct(c.in), width: pct(c.out - c.in) }} />)}
          {cuts.filter((c) => c.status === "accepted").map((c, i) => <span key={`c${i}`} className="pointer-events-none absolute bottom-0 h-1 bg-[var(--danger)]" style={{ left: pct(c.start), width: pct(c.end - c.start) }} />)}
          <span className="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--text)]" style={{ left: pct(t) }} />
        </div>
        <div className="mt-1 flex justify-between text-[11.5px] text-[var(--text-muted)]"><span>Kept {fmt(kept)} of {fmt(duration)} ({Math.round((kept / Math.max(1, duration)) * 100)}%)</span><span className="tnum">{fmt(t)}</span></div>
      </div>
      {segments.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-[var(--border)]">
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2"><span className="text-[12.5px] font-semibold">Transcript</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search transcript" className="ml-auto w-40 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-[12px]" /></div>
          <ol className="max-h-80 overflow-y-auto p-1.5 text-[13px]">
            {shown.map((s) => {
              const removed = !clips.some((c) => s.end > c.in && s.start < c.out);
              return (
                <li key={s.id}>
                  <button type="button" onClick={() => seek(s.start)} className={cn("flex w-full gap-2 rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]", segments[active]?.id === s.id && "bg-[var(--brand-soft)]", removed && "text-[var(--text-subtle)] line-through")}>
                    <span className="tnum mono w-12 shrink-0 text-[11.5px] text-[var(--text-subtle)]">{fmt(s.start)}</span>
                    {s.speaker && <span className="shrink-0 text-[11.5px] font-semibold text-[var(--brand)]">{s.speaker}</span>}
                    <span>{s.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Reorder clips with up/down controls; submits the full order. */
export function ClipOrder({ clips, wsId, editId }: { clips: { id: string; label: string }[]; wsId: string; editId: string }) {
  const [order, setOrder] = React.useState(clips);
  const move = (i: number, d: number) => setOrder((o) => { const n = [...o]; const j = i + d; if (j < 0 || j >= n.length) return n; [n[i], n[j]] = [n[j], n[i]]; return n; });
  return (
    <ActionForm action={clipOrderAction} className="space-y-2">
      <input type="hidden" name="ws" value={wsId} /><input type="hidden" name="edit" value={editId} /><input type="hidden" name="order" value={order.map((c) => c.id).join(",")} />
      <ol className="max-h-72 space-y-1 overflow-y-auto">
        {order.map((c, i) => (
          <li key={c.id} className="flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1 text-[12.5px]">
            <span className="tnum w-6 text-[var(--text-subtle)]">{i + 1}</span><span className="flex-1 truncate">{c.label}</span>
            <button type="button" onClick={() => move(i, -1)} className="px-1 text-[var(--text-muted)] hover:text-[var(--text)]" aria-label="Move up">↑</button>
            <button type="button" onClick={() => move(i, 1)} className="px-1 text-[var(--text-muted)] hover:text-[var(--text)]" aria-label="Move down">↓</button>
          </li>
        ))}
      </ol>
      <SubmitButton size="sm" variant="secondary">Save order</SubmitButton>
    </ActionForm>
  );
}
