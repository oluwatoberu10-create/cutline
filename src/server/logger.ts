import "server-only";

/**
 * Structured JSON logging with redaction. Anything under a secret-looking key
 * is replaced, and token-shaped substrings in messages are masked, so a stray
 * `log.info("…", { headers })` cannot leak credentials into log storage.
 */

const SECRET_KEY = /(token|secret|password|authorization|api[_-]?key|cookie|ciphertext|code_?verifier|session|signature)/i;
const TOKEN_LIKE = /\b(sk-[A-Za-z0-9_-]{12,}|ya29\.[A-Za-z0-9_-]{12,}|1\/\/0[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|GOCSPX-[0-9A-Za-z_-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return value.replace(TOKEN_LIKE, "[redacted]");
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  return value;
}

type Level = "debug" | "info" | "warn" | "error";

function emit(level: Level, msg: string, data?: Record<string, unknown>) {
  if (level === "debug" && process.env.LOG_LEVEL !== "debug") return;
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg: redact(msg), ...(data ? (redact(data) as object) : {}) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const log = {
  debug: (m: string, d?: Record<string, unknown>) => emit("debug", m, d),
  info: (m: string, d?: Record<string, unknown>) => emit("info", m, d),
  warn: (m: string, d?: Record<string, unknown>) => emit("warn", m, d),
  error: (m: string, d?: Record<string, unknown>) => emit("error", m, d),
};
