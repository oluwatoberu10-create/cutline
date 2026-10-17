import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { db } from "@/db";
import { agentDeployments, agentTemplates, blueprintVersions, workspaces } from "@/db/schema";
import { defaultAgentConfig } from "@/lib/blueprint/defaults";
import { jsonDiff } from "@/lib/blueprint/diff";
import { buildBlueprint, configConsistency, contentHash, packageFiles, packageZip, readPackage, validateBlueprintDocument, type ValidationReport } from "@/lib/blueprint/package";
import { scanForSecrets } from "@/lib/blueprint/scan";
import { agentConfigSchema, blueprintSchema, bumpVersion, compareSemver, type AgentConfig, type Blueprint } from "@/lib/blueprint/schema";
import { conflict, notFound, validationError } from "@/lib/errors";
import { validateWorkflow } from "@/lib/workflow/definition";
import { env } from "../env";
import { versions as ffVersions } from "../media/ffmpeg";
import type { OrgCtx } from "../tenancy";
import { audit } from "./audit";
import { deploymentKitFiles } from "./deploy-kit";

export type Template = typeof agentTemplates.$inferSelect;
export type BlueprintVersion = typeof blueprintVersions.$inferSelect;

/* ── templates ────────────────────────────────────────────────────────── */

export async function listTemplates(org: OrgCtx) {
  const rows = await db.select().from(agentTemplates).where(and(eq(agentTemplates.orgId, org.orgId), isNull(agentTemplates.archivedAt))).orderBy(agentTemplates.name);
  const vs = await db.select({ templateId: blueprintVersions.templateId, version: blueprintVersions.version, id: blueprintVersions.id, createdAt: blueprintVersions.createdAt, source: blueprintVersions.source })
    .from(blueprintVersions).where(eq(blueprintVersions.orgId, org.orgId));
  const deps = await db.select({ templateId: agentDeployments.templateId, status: agentDeployments.status }).from(agentDeployments).where(eq(agentDeployments.orgId, org.orgId));
  return rows.map((t) => {
    const mine = vs.filter((v) => v.templateId === t.id).sort((a, b) => compareSemver(b.version, a.version));
    return { template: t, latest: mine[0] ?? null, versionCount: mine.length, deployments: deps.filter((d) => d.templateId === t.id).length, active: deps.filter((d) => d.templateId === t.id && d.status === "active").length };
  });
}

export async function getTemplate(org: OrgCtx, id: string): Promise<Template> {
  const [t] = await db.select().from(agentTemplates).where(and(eq(agentTemplates.id, id), eq(agentTemplates.orgId, org.orgId))).limit(1);
  if (!t) throw notFound("Template not found.");
  return t;
}

export async function createTemplate(org: OrgCtx, input: { name: string; description: string; fromVersionId?: string | null }) {
  const name = input.name.trim().slice(0, 120);
  if (!name) throw validationError("Name the template.");
  const config = input.fromVersionId ? blueprintSchema.parse((await getVersion(org, input.fromVersionId)).content).config : defaultAgentConfig();
  const [t] = await db.insert(agentTemplates).values({ orgId: org.orgId, blueprintUid: randomUUID(), name, description: input.description.slice(0, 2000), draftConfig: config, createdBy: org.actorId }).returning();
  await audit({ orgId: org.orgId, actorId: org.actorId, action: "template.create", entityType: "agent_template", entityId: t.id, summary: `Created template "${name}"` });
  return t;
}

/** Validates a draft config the same way an import would, including the secret scan. */
export function checkConfig(raw: unknown): { config?: AgentConfig; errors: string[]; warnings: string[] } {
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) return { errors: parsed.error.issues.slice(0, 30).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`), warnings: [] };
  const errors = [...configConsistency(parsed.data)];
  const warnings: string[] = [];
  for (const wf of parsed.data.workflows) for (const i of validateWorkflow(wf)) (i.level === "error" ? errors : warnings).push(`Workflow ${wf.key}${i.node ? ` / ${i.node}` : ""}: ${i.message}`);
  const secrets = scanForSecrets(parsed.data);
  for (const s of secrets) errors.push(`${s.path}: looks like a ${s.rule} (${s.excerpt}). Blueprints may only reference secrets by environment-variable name.`);
  return { config: parsed.data, errors, warnings };
}

export async function updateTemplate(org: OrgCtx, id: string, input: { name?: string; description?: string; config?: unknown }) {
  const t = await getTemplate(org, id);
  let config: AgentConfig | undefined;
  if (input.config !== undefined) {
    const r = checkConfig(input.config);
    if (r.errors.length) throw validationError(r.errors.slice(0, 5).join(" "), { errors: r.errors });
    config = r.config;
  }
  await db.update(agentTemplates).set({
    ...(input.name ? { name: input.name.trim().slice(0, 120) } : {}),
    ...(input.description !== undefined ? { description: input.description.slice(0, 2000) } : {}),
    ...(config ? { draftConfig: config } : {}), updatedAt: new Date(),
  }).where(eq(agentTemplates.id, t.id));
  await audit({ orgId: org.orgId, actorId: org.actorId, action: "template.update", entityType: "agent_template", entityId: t.id, summary: `Edited template "${t.name}"` });
}

export async function duplicateTemplate(org: OrgCtx, id: string) {
  const t = await getTemplate(org, id);
  const [copy] = await db.insert(agentTemplates).values({ orgId: org.orgId, blueprintUid: randomUUID(), name: `${t.name} (copy)`.slice(0, 120), description: t.description, draftConfig: t.draftConfig, createdBy: org.actorId }).returning();
  await audit({ orgId: org.orgId, actorId: org.actorId, action: "template.duplicate", entityType: "agent_template", entityId: copy.id, summary: `Duplicated "${t.name}"` });
  return copy;
}

export async function archiveTemplate(org: OrgCtx, id: string) {
  const t = await getTemplate(org, id);
  const [active] = await db.select({ id: agentDeployments.id }).from(agentDeployments).where(and(eq(agentDeployments.templateId, t.id), eq(agentDeployments.status, "active"))).limit(1);
  if (active) throw conflict("This template has active deployments. Pause or move them first.");
  await db.update(agentTemplates).set({ archivedAt: new Date() }).where(eq(agentTemplates.id, t.id));
  await audit({ orgId: org.orgId, actorId: org.actorId, action: "template.archive", entityType: "agent_template", entityId: t.id, summary: `Archived "${t.name}"` });
}

/* ── versions ─────────────────────────────────────────────────────────── */

export async function listVersions(org: OrgCtx, templateId: string) {
  const rows = await db.select().from(blueprintVersions).where(and(eq(blueprintVersions.templateId, templateId), eq(blueprintVersions.orgId, org.orgId)));
  return rows.sort((a, b) => compareSemver(b.version, a.version));
}

export async function getVersion(org: OrgCtx, id: string): Promise<BlueprintVersion> {
  const [v] = await db.select().from(blueprintVersions).where(and(eq(blueprintVersions.id, id), eq(blueprintVersions.orgId, org.orgId))).limit(1);
  if (!v) throw notFound("Blueprint version not found.");
  return v;
}

export async function listAllVersions(org: OrgCtx) {
  return db.select({ v: blueprintVersions, name: agentTemplates.name }).from(blueprintVersions).innerJoin(agentTemplates, eq(agentTemplates.id, blueprintVersions.templateId))
    .where(and(eq(blueprintVersions.orgId, org.orgId), isNull(agentTemplates.archivedAt))).orderBy(agentTemplates.name, desc(blueprintVersions.createdAt));
}

/** Freezes the template's draft as a new immutable version. Existing deployments are untouched. */
export async function publishVersion(org: OrgCtx, templateId: string, input: { bump: "major" | "minor" | "patch"; changelog: string }) {
  const t = await getTemplate(org, templateId);
  const existing = await listVersions(org, t.id);
  const latest = existing[0];
  const version = latest ? bumpVersion(latest.version, input.bump) : "1.0.0";
  const bp = buildBlueprint({ uid: t.blueprintUid, name: t.name, description: t.description, version, changelog: input.changelog.slice(0, 4000) }, agentConfigSchema.parse(t.draftConfig));
  const report = validateBlueprintDocument(JSON.parse(JSON.stringify(bp)));
  if (!report.ok) throw validationError(`The template is not valid: ${report.errors.slice(0, 5).join(" ")}`, { errors: report.errors });
  if (latest && configHash(blueprintSchema.parse(latest.content).config) === configHash(bp.config)) throw conflict(`Nothing changed since version ${latest.version}.`);
  const [row] = await db.insert(blueprintVersions).values({
    orgId: org.orgId, templateId: t.id, blueprintUid: t.blueprintUid, version, schemaVersion: bp.schemaVersion, content: bp, contentHash: contentHash(bp),
    changelog: input.changelog.slice(0, 4000), source: "published", createdBy: org.actorId,
  }).returning();
  await audit({ orgId: org.orgId, actorId: org.actorId, action: "blueprint.publish", entityType: "blueprint_version", entityId: row.id, summary: `Published "${t.name}" v${version}` });
  return row;
}

const configHash = (c: AgentConfig) => createHash("sha256").update(JSON.stringify(c)).digest("hex");

export async function versionDiff(org: OrgCtx, fromId: string, toId: string) {
  const a = blueprintSchema.parse((await getVersion(org, fromId)).content), b = blueprintSchema.parse((await getVersion(org, toId)).content);
  return jsonDiff(a.config, b.config);
}

/* ── export ───────────────────────────────────────────────────────────── */

export const EXPORT_EXCLUSIONS = [
  "API keys, OAuth access and refresh tokens, passwords, encryption keys",
  "Client footage, renders, transcripts, captions and thumbnails",
  "Channel analytics, video lists, ideas, calendars and feedback",
  "Client names, emails, account and channel ids, storage paths and signed URLs",
  "Workspace overrides and integration bindings of any deployment",
];

/**
 * Exactly what an export will contain. The scan re-checks every file; any
 * finding blocks the export (it would mean a secret reached a template).
 */
export async function exportPreview(org: OrgCtx, versionId: string) {
  const v = await getVersion(org, versionId);
  const bp = blueprintSchema.parse(v.content);
  const files = packageFiles(bp);
  const findings = files.flatMap((f) => scanForSecrets(f.content).map((s) => ({ ...s, file: f.path })));
  return {
    version: v, blueprint: bp,
    files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content), preview: f.path === "blueprint.json" || f.path.endsWith(".schema.json") ? null : f.content.slice(0, 4000) })),
    findings, excluded: EXPORT_EXCLUSIONS, blocked: findings.length > 0,
  };
}

export async function exportPackage(org: OrgCtx, versionId: string, format: "json" | "zip" | "kit"): Promise<{ filename: string; contentType: string; body: Uint8Array }> {
  const preview = await exportPreview(org, versionId);
  if (preview.blocked) throw validationError("Export blocked: the blueprint contains values that look like secrets or private data.", { findings: preview.findings });
  const bp = preview.blueprint;
  const slug = bp.blueprint.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "blueprint";
  await audit({ orgId: org.orgId, actorId: org.actorId, action: "blueprint.export", entityType: "blueprint_version", entityId: versionId, summary: `Exported "${bp.blueprint.name}" v${bp.blueprint.version} as ${format}` });
  if (format === "json") return { filename: `${slug}-v${bp.blueprint.version}.json`, contentType: "application/json", body: strToU8(JSON.stringify(bp, null, 2)) };
  if (format === "zip") return { filename: `${slug}-v${bp.blueprint.version}.zip`, contentType: "application/zip", body: packageZip(bp) };
  const entries: Record<string, Uint8Array> = {};
  entries[`blueprint/${slug}-v${bp.blueprint.version}.zip`] = packageZip(bp);
  for (const f of deploymentKitFiles(bp, `blueprint/${slug}-v${bp.blueprint.version}.zip`)) entries[f.path] = strToU8(f.content);
  const kitFindings = Object.entries(entries).filter(([p]) => !p.endsWith(".zip")).flatMap(([p, c]) => scanForSecrets(Buffer.from(c).toString("utf8")).map((s) => `${p}: ${s.rule}`));
  if (kitFindings.length) throw validationError(`Deployment kit blocked: ${kitFindings.join("; ")}`);
  return { filename: `${slug}-v${bp.blueprint.version}-deployment-kit.zip`, contentType: "application/zip", body: zipSync(entries, { level: 6 }) };
}

/* ── import ───────────────────────────────────────────────────────────── */

export type ImportPlan = {
  report: ValidationReport;
  packageProblems: string[];
  contentHash: string | null;
  action: "create_template" | "add_version" | "already_imported" | "version_conflict" | "invalid";
  existingTemplate: { id: string; name: string } | null;
  environment: { label: string; ok: boolean; detail: string }[];
};

/** Step 1 of import: validate and explain what would happen. Writes nothing. */
export async function previewImport(org: OrgCtx, bytes: Uint8Array, filename: string): Promise<ImportPlan> {
  const { raw, problems } = readPackage(bytes, filename);
  const report = raw === undefined ? { ok: false, errors: problems, warnings: [], secrets: [], workflowIssues: [], compatibility: { appVersion: "", compatible: false }, requirements: { integrations: [], env: [], capabilities: [] } } as ValidationReport : validateBlueprintDocument(raw);
  const hard = problems.filter((p) => /Checksum mismatch|missing|unsafe|Could not read|not valid/i.test(p));
  if (!report.ok || hard.length || !report.blueprint) {
    return { report, packageProblems: problems, contentHash: null, action: "invalid", existingTemplate: null, environment: [] };
  }
  const bp = report.blueprint;
  const hash = contentHash(bp);
  const [tpl] = await db.select().from(agentTemplates).where(and(eq(agentTemplates.orgId, org.orgId), eq(agentTemplates.blueprintUid, bp.blueprint.uid))).limit(1);
  let action: ImportPlan["action"] = "create_template";
  if (tpl) {
    const [same] = await db.select().from(blueprintVersions).where(and(eq(blueprintVersions.templateId, tpl.id), eq(blueprintVersions.version, bp.blueprint.version))).limit(1);
    action = !same ? "add_version" : same.contentHash === hash ? "already_imported" : "version_conflict";
  }
  return { report, packageProblems: problems, contentHash: hash, action, existingTemplate: tpl ? { id: tpl.id, name: tpl.name } : null, environment: await environmentChecks(bp) };
}

/** What this installation can provide for the blueprint's requirements. */
export async function environmentChecks(bp: Blueprint) {
  const out: { label: string; ok: boolean; detail: string }[] = [];
  const ff = await ffVersions();
  if (bp.config.capabilities.includes("ffmpeg")) out.push({ label: "FFmpeg", ok: Boolean(ff.ffmpeg), detail: ff.ffmpeg ?? "Not found — install FFmpeg or set FFMPEG_PATH." });
  if (bp.config.capabilities.includes("ffprobe")) out.push({ label: "FFprobe", ok: Boolean(ff.ffprobe), detail: ff.ffprobe ?? "Not found — install FFmpeg or set FFPROBE_PATH." });
  if (bp.config.integrations.some((i) => i.kind === "youtube")) out.push({ label: "YouTube OAuth client", ok: Boolean(env.google()), detail: env.google() ? "GOOGLE_OAUTH_CLIENT_ID/SECRET set" : "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET before clients can connect channels." });
  for (const e of bp.config.env.filter((x) => x.required)) out.push({ label: `Env ${e.name}`, ok: Boolean(process.env[e.name]), detail: process.env[e.name] ? "set" : "not set on this installation" });
  return out;
}

/**
 * Step 2 of import: the user confirmed the plan. The content hash must match
 * what they reviewed. Never modifies deployments or a template's draft.
 */
export async function confirmImport(org: OrgCtx, bytes: Uint8Array, filename: string, expectedHash: string, opts: { asNewTemplate?: boolean } = {}) {
  const plan = await previewImport(org, bytes, filename);
  if (plan.action === "invalid" || !plan.report.blueprint) throw validationError("The package is not valid.", { errors: plan.report.errors });
  if (plan.contentHash !== expectedHash) throw conflict("The file differs from the one you reviewed. Preview it again.");
  if (plan.action === "already_imported") return { templateId: plan.existingTemplate!.id, versionId: null, action: plan.action };
  const bp = plan.report.blueprint;

  if (plan.action === "version_conflict" && !opts.asNewTemplate) throw conflict(`Version ${bp.blueprint.version} already exists with different content. Import it as a new template instead.`);
  // A fork gets its own identity so it never collides with the original lineage.
  const fork = opts.asNewTemplate === true && plan.action !== "create_template";
  const content: Blueprint = fork ? { ...bp, blueprint: { ...bp.blueprint, uid: randomUUID() } } : bp;

  return db.transaction(async (tx) => {
    let templateId: string;
    if (plan.action === "create_template" || fork) {
      const [t] = await tx.insert(agentTemplates).values({
        orgId: org.orgId, blueprintUid: content.blueprint.uid, name: fork ? `${bp.blueprint.name} (imported)` : bp.blueprint.name,
        description: bp.blueprint.description, draftConfig: bp.config, createdBy: org.actorId,
      }).returning();
      templateId = t.id;
    } else {
      templateId = plan.existingTemplate!.id;
    }
    const [v] = await tx.insert(blueprintVersions).values({
      orgId: org.orgId, templateId, blueprintUid: content.blueprint.uid, version: bp.blueprint.version, schemaVersion: bp.schemaVersion,
      content, contentHash: contentHash(content), changelog: bp.blueprint.changelog, source: "imported",
      importReport: { warnings: plan.report.warnings, packageProblems: plan.packageProblems, environment: plan.environment, filename: filename.slice(0, 200) }, createdBy: org.actorId,
    }).returning();
    await audit({ orgId: org.orgId, actorId: org.actorId, action: "blueprint.import", entityType: "blueprint_version", entityId: v.id, summary: `Imported "${bp.blueprint.name}" v${bp.blueprint.version} (${plan.action.replace("_", " ")})` }, tx);
    return { templateId, versionId: v.id, action: plan.action };
  });
}

/** Deployments of a version, for the library and update notices. */
export async function deploymentsOfTemplate(org: OrgCtx, templateId: string) {
  return db.select({ d: agentDeployments, ws: workspaces.name, version: blueprintVersions.version }).from(agentDeployments)
    .innerJoin(workspaces, eq(workspaces.id, agentDeployments.workspaceId)).innerJoin(blueprintVersions, eq(blueprintVersions.id, agentDeployments.blueprintVersionId))
    .where(and(eq(agentDeployments.templateId, templateId), eq(agentDeployments.orgId, org.orgId)));
}
