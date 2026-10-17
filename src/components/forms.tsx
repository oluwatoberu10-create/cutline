"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFormState } from "./ui/action-form";
import { Button } from "./ui/button";

/** Shows a one-time value an action returned (an API token, an invite link) with a copy button. */
export function RevealData({ field, label, prefixOrigin }: { field: string; label: string; prefixOrigin?: boolean }) {
  const state = useFormState();
  const raw = state.ok ? state.data?.[field] : null;
  const [copied, setCopied] = React.useState(false);
  if (!raw) return null;
  const value = prefixOrigin && typeof window !== "undefined" ? `${window.location.origin}${raw}` : String(raw);
  return (
    <div className="mt-3 rounded-[var(--radius-field)] border border-[var(--success)]/30 bg-[var(--success-soft)] p-3">
      <div className="text-[12px] font-semibold text-[var(--success)]">{label}</div>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="mono min-w-0 flex-1 truncate rounded bg-[var(--surface)] px-2 py-1.5 text-[12.5px]">{value}</code>
        <Button type="button" size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); }}>{copied ? "Copied" : "Copy"}</Button>
      </div>
    </div>
  );
}

/** Renders server-provided JSON returned by an action (e.g. an import plan) through a render prop. */
export function ActionData<T>({ field, children }: { field: string; children: (value: T) => React.ReactNode }) {
  const state = useFormState();
  const raw = state.ok ? state.data?.[field] : null;
  if (typeof raw !== "string") return null;
  try { return <>{children(JSON.parse(raw) as T)}</>; } catch { return null; }
}

/** Polls the server-rendered page while background work is in flight. */
export function AutoRefresh({ active, intervalMs = 3000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
