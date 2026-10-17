import * as React from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";

export type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-[var(--surface-2)] text-[var(--text-muted)] border-[var(--border)]",
  brand: "bg-[var(--brand-soft)] text-[var(--brand)] border-[var(--brand-border)]",
  success: "bg-[var(--success-soft)] text-[var(--success)] border-[var(--success)]/25",
  warning: "bg-[var(--warning-soft)] text-[var(--warning)] border-[var(--warning)]/25",
  danger: "bg-[var(--danger-soft)] text-[var(--danger)] border-[var(--danger)]/25",
  info: "bg-[var(--info-soft)] text-[var(--info)] border-[var(--info)]/25",
};

export function Badge({ tone = "neutral", className, ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-semibold whitespace-nowrap", tones[tone], className)} {...props} />;
}

/** One mapping from every status string in the system to a tone and label. */
const STATUS: Record<string, [Tone, string]> = {
  queued: ["neutral", "Queued"], running: ["info", "Running"], waiting: ["warning", "Waiting for approval"], succeeded: ["success", "Succeeded"],
  failed: ["danger", "Failed"], cancelled: ["neutral", "Cancelled"], skipped: ["neutral", "Skipped"], pending: ["neutral", "Pending"],
  uploading: ["info", "Uploading"], processing: ["info", "Processing"], ready: ["success", "Ready"], deleted: ["neutral", "Deleted"],
  draft: ["neutral", "Draft"], in_review: ["warning", "In review"], approved: ["success", "Approved"], rendering: ["info", "Rendering"], rendered: ["success", "Rendered"],
  awaiting_approval: ["warning", "Awaiting approval"], scheduled: ["brand", "Scheduled"], published: ["success", "Published"],
  proposed: ["brand", "Proposed"], saved: ["info", "Saved"], rejected: ["danger", "Rejected"], in_production: ["info", "In production"], archived: ["neutral", "Archived"],
  active: ["success", "Active"], paused: ["warning", "Paused"], connected: ["success", "Connected"], error: ["danger", "Needs attention"], revoked: ["neutral", "Revoked"],
  pass: ["success", "Pass"], fail: ["danger", "Fail"], warn: ["warning", "Warning"], accepted: ["success", "Applied"],
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const [tone, text] = STATUS[status] ?? ["neutral", status.replace(/_/g, " ")];
  return <Badge tone={tone}>{status === "running" || status === "uploading" || status === "processing" || status === "rendering" ? <span className="anim-pulse inline-block h-1.5 w-1.5 rounded-full bg-current" /> : null}{label ?? text}</Badge>;
}

export function MockBadge() {
  return <Badge tone="warning" title="Produced by a test-only mock provider, not a real AI model">Mock provider</Badge>;
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("card", className)} {...props} />;
}

export function CardHeader({ title, description, action, className }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-0.5 text-[13px] text-[var(--text-muted)]">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-5", className)} {...props} />;
}

export function PageHeader({ title, description, eyebrow, actions, back }: {
  title: React.ReactNode; description?: React.ReactNode; eyebrow?: React.ReactNode; actions?: React.ReactNode; back?: { href: string; label: string };
}) {
  return (
    <div className="mb-6">
      {back && (
        <Link href={back.href} className="mb-3 inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
          <Icon name="arrowLeft" className="h-3.5 w-3.5" />{back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <div className="mb-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[var(--brand)]">{eyebrow}</div>}
          <h1 className="text-[22px] font-bold leading-tight tracking-tight sm:text-[26px]">{title}</h1>
          {description && <p className="mt-1.5 max-w-3xl text-[14px] text-[var(--text-muted)]">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function StatCard({ label, value, hint, href, tone = "default", icon, definition }: {
  label: string; value: React.ReactNode; hint?: React.ReactNode; href?: string; tone?: "default" | "success" | "warning" | "danger" | "brand"; icon?: IconName; definition?: string;
}) {
  const toneClass = { default: "text-[var(--text-subtle)] bg-[var(--surface-2)]", brand: "text-[var(--brand)] bg-[var(--brand-soft)]", success: "text-[var(--success)] bg-[var(--success-soft)]", warning: "text-[var(--warning)] bg-[var(--warning-soft)]", danger: "text-[var(--danger)] bg-[var(--danger-soft)]" }[tone];
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-[var(--text-subtle)]" title={definition}>{label}</span>
        {icon && <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", toneClass)}><Icon name={icon} className="h-4 w-4" /></span>}
      </div>
      <div className="tnum mt-2 text-[26px] font-bold leading-none tracking-tight">{value}</div>
      {hint && <p className="mt-2 text-[12px] leading-snug text-[var(--text-muted)]">{hint}</p>}
    </>
  );
  const cls = cn("card anim-rise block p-4 sm:p-5", href && "lift");
  return href ? <Link href={href} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}

export function EmptyState({ title, description, action, icon = "inbox", compact }: { title: string; description?: React.ReactNode; action?: React.ReactNode; icon?: IconName; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 text-center", compact ? "py-8" : "py-14")}>
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name={icon} className="h-5 w-5" /></div>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      {description && <div className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[var(--text-muted)]">{description}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "info", title, children, icon }: { tone?: "info" | "warning" | "success" | "danger" | "brand"; title?: React.ReactNode; children?: React.ReactNode; icon?: IconName }) {
  const cls = {
    info: "border-[var(--info)]/25 bg-[var(--info-soft)] text-[var(--info)]",
    warning: "border-[var(--warning)]/25 bg-[var(--warning-soft)] text-[var(--warning)]",
    success: "border-[var(--success)]/25 bg-[var(--success-soft)] text-[var(--success)]",
    danger: "border-[var(--danger)]/25 bg-[var(--danger-soft)] text-[var(--danger)]",
    brand: "border-[var(--brand-border)] bg-[var(--brand-soft)] text-[var(--brand)]",
  }[tone];
  const ic: IconName = icon ?? (tone === "success" ? "checkCircle" : tone === "info" || tone === "brand" ? "bell" : "alert");
  return (
    <div className={cn("flex gap-3 rounded-[var(--radius-field)] border px-4 py-3 text-[13.5px]", cls)} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={ic} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cn("text-[var(--text)]", Boolean(title) && "mt-0.5")}>{children}</div>}
      </div>
    </div>
  );
}

/** "Not configured" state with the exact next step — used instead of fabricated output. */
export function SetupRequired({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--border-strong)] bg-[var(--surface)] p-5">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--attention-soft)] text-[var(--attention)]"><Icon name="settings" className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-semibold">{title}</div>
          <div className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">{children}</div>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  );
}

export function ProgressBar({ value, max = 100, tone = "brand", className, label }: { value: number; max?: number; tone?: "brand" | "success" | "warning" | "danger"; className?: string; label?: string }) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const color = { brand: "var(--brand)", success: "var(--success)", warning: "var(--warning)", danger: "var(--danger)" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-3)]", className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Tabs({ items, active }: { items: { href: string; label: string; key: string; count?: number }[]; active: string }) {
  return (
    <div className="mb-5 flex gap-1 overflow-x-auto border-b border-[var(--border)]" role="tablist">
      {items.map((t) => (
        <Link key={t.key} href={t.href} role="tab" aria-selected={t.key === active}
          className={cn("-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors",
            t.key === active ? "border-[var(--brand)] text-[var(--text)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]")}>
          {t.label}{t.count !== undefined && <span className="tnum rounded-full bg-[var(--surface-2)] px-1.5 text-[11px] text-[var(--text-muted)]">{t.count}</span>}
        </Link>
      ))}
    </div>
  );
}

export function KeyValue({ items }: { items: [React.ReactNode, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-6 gap-y-2.5 text-[13.5px]">
      {items.map(([k, v], i) => (
        <React.Fragment key={i}>
          <dt className="text-[var(--text-muted)]">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-3", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.09em] text-[var(--text-subtle)]">{title}</h3>
      {children}
    </section>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-[var(--radius-field)]", className)} />;
}

export function Timestamp({ value, tz = "UTC" }: { value: Date | string | null | undefined; tz?: string }) {
  if (!value) return <span className="text-[var(--text-subtle)]">—</span>;
  const d = typeof value === "string" ? new Date(value) : value;
  return <time dateTime={d.toISOString()} title={d.toISOString()}>{new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d)}</time>;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const s = Math.round(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** Adds the download flag to our own signed media paths; presigned S3 URLs must not be altered. */
export function downloadHref(url: string): string {
  return url.startsWith("/api/media/") ? `${url}&download=1` : url;
}
