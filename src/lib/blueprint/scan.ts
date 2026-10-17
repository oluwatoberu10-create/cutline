/**
 * Secret and private-data scanner for blueprints.
 *
 * Runs on every export (a hit blocks the export) and every import (a hit
 * blocks the import). The schema already rejects unknown keys, so this is the
 * second line of defence: it catches credentials pasted into free-text fields
 * such as instructions, descriptions or examples.
 */

export type ScanFinding = { path: string; rule: string; excerpt: string };

const VALUE_RULES: { rule: string; re: RegExp }[] = [
  { rule: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { rule: "OpenAI-style API key", re: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/ },
  { rule: "Google API key", re: /\bAIza[0-9A-Za-z_-]{30,}/ },
  { rule: "Google OAuth access token", re: /\bya29\.[0-9A-Za-z_-]{20,}/ },
  { rule: "Google OAuth refresh token", re: /\b1\/\/0[0-9A-Za-z_-]{20,}/ },
  { rule: "Google OAuth client secret", re: /\bGOCSPX-[0-9A-Za-z_-]{20,}/ },
  { rule: "AWS access key id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { rule: "Slack token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "Deepgram-style hex key", re: /\b[a-f0-9]{40}\b/ },
  { rule: "JSON web token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { rule: "Signed URL", re: /[?&](X-Amz-Signature|X-Goog-Signature|sig|signature|token)=[^&\s]{8,}/i },
  { rule: "Bearer credential", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  { rule: "Basic-auth URL", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { rule: "YouTube channel id", re: /\bUC[0-9A-Za-z_-]{22}\b/ },
  { rule: "Email address", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { rule: "Local filesystem path", re: /(^|[\s"'])([A-Za-z]:\\|\/(home|Users|var|tmp)\/)[^\s"']+/ },
];

/** Keys whose presence with a non-empty value means a secret field leaked into the document. */
const SECRET_KEY = /^(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|access[_-]?token|refresh[_-]?token|id[_-]?token|token|private[_-]?key|authorization|cookie|session)$/i;

/** Placeholders documentation may legitimately use. */
const PLACEHOLDER = /^(<[^>]+>|\$\{?[A-Z0-9_]+\}?|x{4,}|\*{3,}|example|changeme|your[-_ ].*)$/i;

export function scanForSecrets(value: unknown, path = "$", out: ScanFinding[] = []): ScanFinding[] {
  if (typeof value === "string") {
    for (const { rule, re } of VALUE_RULES) {
      const m = re.exec(value);
      // Environment-variable interpolation (e.g. postgresql://user:${PASSWORD}@db) is a placeholder, not a credential.
      if (m && !PLACEHOLDER.test(m[0]) && !/\$\{[A-Z0-9_]+[^}]*\}/.test(m[0])) {
        out.push({ path, rule, excerpt: redact(m[0]) });
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => scanForSecrets(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = `${path}.${k}`;
      if (SECRET_KEY.test(k) && typeof v === "string" && v.trim() && !PLACEHOLDER.test(v.trim())) {
        out.push({ path: p, rule: `Secret-named field "${k}"`, excerpt: redact(v) });
      }
      scanForSecrets(v, p, out);
    }
  }
  return out;
}

function redact(s: string): string {
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}
