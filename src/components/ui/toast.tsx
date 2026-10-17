"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";

type ToastKind = "success" | "error" | "info";
type Toast = { id: number; kind: ToastKind; message: string; leaving?: boolean };

const DURATION = 5000;
const EXIT_MS = 220;

const ToastContext = React.createContext<{
  push: (kind: ToastKind, message: string) => void;
} | null>(null);

const ICONS: Record<ToastKind, IconName> = {
  success: "check",
  error: "alert",
  info: "bell",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(0);
  const timers = React.useRef(new Map<number, ReturnType<typeof setTimeout>>());

  // Two-phase removal: mark leaving so the exit animation can play, then drop
  // the row. Without this a toast vanishes mid-slide.
  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      timers.current.delete(id);
    }, EXIT_MS);
    timers.current.set(id, timer);
  }, []);

  const push = React.useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev.slice(-3), { id, kind, message }]);
    const timer = setTimeout(() => dismiss(id), DURATION);
    timers.current.set(id, timer);
  }, [dismiss]);

  React.useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className={cn(
              "pointer-events-auto relative flex w-full max-w-sm items-start gap-3 overflow-hidden rounded-[var(--radius-field)] border px-4 py-3 text-sm shadow-[var(--shadow-overlay)]",
              toast.leaving ? "anim-fade" : "anim-pop",
              toast.kind === "success" && "border-[var(--success)]/30 bg-[var(--success-soft)] text-[var(--success)]",
              toast.kind === "error" && "border-[var(--danger)]/30 bg-[var(--danger-soft)] text-[var(--danger)]",
              toast.kind === "info" && "border-[var(--border)] bg-[var(--overlay)] text-[var(--text)]",
            )}
            style={
              toast.leaving
                ? { animationDirection: "reverse", opacity: 0, transform: "translateY(6px) scale(0.97)",
                    transition: `opacity ${EXIT_MS}ms var(--ease-out-soft), transform ${EXIT_MS}ms var(--ease-out-soft)` }
                : undefined
            }
          >
            <Icon name={ICONS[toast.kind]} className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="flex-1 font-medium">{toast.message}</span>
            <button
              onClick={() => dismiss(toast.id)}
              className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
              aria-label="Dismiss notification"
            >
              ✕
            </button>

            {/* Counts down the time remaining, so the dismissal is not a surprise. */}
            {!toast.leaving && (
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-current opacity-25"
                style={{ animation: `dt-drain ${DURATION}ms linear both` }}
              />
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
