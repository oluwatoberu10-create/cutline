import { existsSync, readFileSync } from "node:fs";

/**
 * Reads .env into process.env for the standalone scripts.
 *
 * On Vercel the environment is already populated and this does nothing.
 * Locally there is a file instead — reading it here keeps the same command
 * working in both places without a Node-version-specific --env-file flag.
 *
 * `.env.local` wins over `.env`, matching Next's own precedence, so a project
 * linked with `vercel link` talks to the linked database rather than the
 * local cluster.
 */
export function loadDotEnv(files = [".env.local", ".env"]): void {
  for (const file of files) {
    if (!existsSync(file)) continue;

    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!match) continue;

      const [, key, raw] = match;
      // Anything already in the environment wins over any file.
      if (process.env[key] !== undefined) continue;
      process.env[key] = raw.replace(/^["']|["']$/g, "");
    }
  }
}
