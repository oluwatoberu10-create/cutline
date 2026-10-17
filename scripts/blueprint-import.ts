/**
 * Imports a blueprint package into the installation's agency (client-owned installs).
 *   npm run blueprint:import -- ./package.zip [--org <orgId>] [--yes]
 * Shows the validation report and plan; imports only with --yes.
 */
import { readFileSync } from "node:fs";
import { loadDotEnv } from "./env";

async function main() {
  loadDotEnv();
  const { ensureEnv } = await import("./pg");
  ensureEnv();
  const file = process.argv[2];
  if (!file) { console.error("usage: npm run blueprint:import -- <file> [--org <orgId>] [--yes]"); process.exit(1); }
  const { db } = await import("../src/db");
  const { organizations, orgMemberships } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const orgFlag = process.argv.indexOf("--org");
  const orgs = await db.select().from(organizations);
  const org = orgFlag > -1 ? orgs.find((o) => o.id === process.argv[orgFlag + 1]) : orgs[0];
  if (!org) { console.error("No organization found. Run npm run admin:create first."); process.exit(1); }
  const [admin] = await db.select().from(orgMemberships).where(eq(orgMemberships.orgId, org.id));
  const ctx = { orgId: org.id, orgName: org.name, actorId: admin.userId, isAdmin: true };
  const { previewImport, confirmImport } = await import("../src/server/services/blueprints");
  const bytes = new Uint8Array(readFileSync(file));
  const plan = await previewImport(ctx, bytes, file);
  console.log(`Plan: ${plan.action}${plan.existingTemplate ? ` (template "${plan.existingTemplate.name}")` : ""}`);
  for (const e of plan.report.errors) console.log(`error: ${e}`);
  for (const w of plan.report.warnings) console.log(`warning: ${w}`);
  for (const p of plan.packageProblems) console.log(`package: ${p}`);
  for (const c of plan.environment) console.log(`${c.ok ? "ok  " : "MISS"} ${c.label}: ${c.detail}`);
  if (plan.action === "invalid") process.exit(1);
  if (!process.argv.includes("--yes")) { console.log("Re-run with --yes to import."); process.exit(0); }
  const r = await confirmImport(ctx, bytes, file, plan.contentHash!);
  console.log(`Imported (${r.action}). Template ${r.templateId}${r.versionId ? `, version ${r.versionId}` : ""}.`);
  const { closePool } = await import("../src/db/migrate");
  await closePool();
}
main().catch((e) => { console.error("[blueprint:import]", e instanceof Error ? e.message : e); process.exit(1); });
