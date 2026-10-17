/** Tiny class combiner — avoids pulling clsx/tailwind-merge for this use. */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function fullName(p: { firstName: string; lastName: string }): string {
  return `${p.firstName} ${p.lastName}`.trim();
}

export function initials(p: { firstName: string; lastName: string }): string {
  return `${p.firstName.charAt(0)}${p.lastName.charAt(0)}`.toUpperCase();
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-GB").format(n);
}

export function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

export function formatPct(value: number | null): string {
  return value === null ? "—" : `${value}%`;
}

/**
 * Formats an instant for display in a given IANA zone. Every user-facing time
 * goes through here so a deadline reads the same on the server and the client.
 */
export function formatDateTime(
  value: Date | string | null | undefined,
  timeZone: string,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" },
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone, ...opts }).format(date);
}

/** Formats a calendar date (YYYY-MM-DD) without any timezone shift. */
export function formatDateOnly(
  value: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" },
): string {
  if (!value) return "—";
  const [y, m, d] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...opts }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function relativeTime(value: Date | string | null | undefined, now = Date.now()): string {
  if (!value) return "never";
  const date = typeof value === "string" ? new Date(value) : value;
  const diff = now - date.getTime();
  const future = diff < 0;
  const mins = Math.round(Math.abs(diff) / 60000);
  const say = (n: number, unit: string) => (future ? `in ${n}${unit}` : `${n}${unit} ago`);
  if (mins < 1) return "just now";
  if (mins < 60) return say(mins, "m");
  const hours = Math.round(mins / 60);
  if (hours < 24) return say(hours, "h");
  const days = Math.round(hours / 24);
  if (days < 30) return say(days, "d");
  const months = Math.round(days / 30);
  if (months < 12) return say(months, "mo");
  return say(Math.round(months / 12), "y");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/** Only allow same-site relative paths as redirect/link targets. */
export function safeInternalPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
