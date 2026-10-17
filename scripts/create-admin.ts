/**
 * Creates the first agency and administrator from the command line (for
 * headless/client-owned installs). Prints a one-time password.
 *   npm run admin:create -- --org "My Agency" --email me@example.com --name "Me"
 */
import { randomBytes } from "node:crypto";
import { loadDotEnv } from "./env";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  loadDotEnv();
  const { ensureEnv } = await import("./pg");
  ensureEnv();
  const org = arg("org"), email = arg("email"), name = arg("name");
  if (!org || !email || !name) { console.error('usage: npm run admin:create -- --org "Agency" --email you@example.com --name "Your Name"'); process.exit(1); }
  const password = randomBytes(12).toString("base64url");
  const { bootstrap } = await import("../src/server/services/workspaces");
  await bootstrap({ orgName: org, name, email, password });
  const { closePool } = await import("../src/db/migrate");
  await closePool();
  console.log(`Created ${email}. One-time password: ${password}\nSign in and change it under Settings.`);
}
main().catch((e) => { console.error("[admin:create]", e instanceof Error ? e.message : e); process.exit(1); });
