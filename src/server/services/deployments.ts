import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentDeployments, agentTemplates, blueprintVersions, deploymentRevisions, workspaces } from "@/db/schema";
import { deepEqual, jsonDiff } from "@/lib/blueprint/diff";
import { blueprintSchema, compareSemver, type AgentConfig, type Blueprint } from "@/lib/blueprint/schema";
import { AppError, conflict, notFound, validationError } from "@/lib/errors";
import { evaluate } from "@/lib/workflow/condition";
import { topoSort, validateWorkflow } from "@/lib/workflow/definition";
import { nodeSpec } from "@/lib/workflow/nodes";
import { detectSilences, ffmpeg, probe, versions as ffVersions } from "../media/ffmpeg";
import type { OrgCtx, WorkspaceCtx } from "../tenancy";
import { mergeConfig } from "./agent-config";
import { audit, auditWs } from "./audit";
import { getLlm, getTranscriber, listConnections, resolveConnection, testConnection } from "./integrations";
import { getProfile, updateProfile, type profileInput } from "./workspaces";
import type { z } from "zod";

export type Deployment = typeof agentDeployments.$inferSelect;
export type Check = { id: string; label: string; status: "pass" | "fail" | "warn"; message: string };

async function versionContent(id: string): Promise<{ row: typeof blueprintVersions.$inferSelect; bp: Blueprint }> {
  const [row] = await db.select().from(blueprintVersions).where(eq(blueprintVersions.id, id)).limit(1);
  if (!row) throw notFound("Blueprint version not found.");
  return { row, bp: blueprintSchema.parse(row.content) };
}

export async function getDeployment(ws: WorkspaceCtx) {
  const [row] = await db.select({ d: agentDeployments, version: blueprintVersions.version, templateName: agentTemplates.name }).from(agentDeployments)
    .innerJoin(blueprintVersions, eq(blueprintVersions.id, agentDeployments.blueprintVersionId)).innerJoin(agentTemplates, eq(agentTemplates.id, agentDeployments.templateId))
    .where(eq(agentDeployments.workspaceId, ws.workspaceId)).limit(1);
  return row ?? null;
}

async function requireDeployment(ws: WorkspaceCtx): Promise<Deployment> {
  const [d] = await db.select().from(agentDeployments).where(eq(agentDeployments.workspaceId, ws.workspaceId)).limit(1);
  if (!d) throw notFound("No deployment in this workspace.");
  return d;
}

/* ── wizard steps 1–2: blueprint + workspace ──────────────────────────── */

/**
 * Starts (or restarts, while still a draft) a deployment of a blueprint
 * version into a workspace that belongs to the same agency.
 */
export async function startDeployment(org: OrgCtx, input: { blueprintVersionId: string; workspaceId: string }) {
  const [v] = await db.select().from(blueprintVersions).where(and(eq(blueprintVersions.id, input.blueprintVersionId), eq(blueprintVersions.orgId, org.orgId))).limit(1);
  if (!v) throw notFound("Blueprint version not found.");
  const [ws] = await db.select().from(workspaces).where(and(eq(workspaces.id, input.workspaceId), eq(workspaces.orgId, org.orgId))).limit(1);
  if (!ws) throw notFound("Workspace not found.");
  if (ws.status === "archived") throw validationError("Restore the workspace before deploying to it.");
  const [existing] = await db.select().from(agentDeployments).where(eq(agentDeployments.workspaceId, ws.id)).limit(1);
  if (existing && existing.status !== "draft") throw conflict("This workspace already has a deployed agent. Use its Agent page to review and apply a different version.");
  const bp = blueprintSchema.parse(v.content);
  const [row] = existing
    ? await db.update(agentDeployments).set({ templateId: v.templateId, blueprintVersionId: v.id, wizardStep: 3, validation: null, testResults: null, updatedAt: new Date() }).where(eq(agentDeployments.id, existing.id)).returning()
    : await db.insert(agentDeployments).values({ orgId: org.orgId, workspaceId: ws.id, templateId: v.templateId, blueprintVersionId: v.id, status: "draft", wizardStep: 3 }).returning();
  await audit({ orgId: org.orgId, workspaceId: ws.id, actorId: org.actorId, action: "deployment.start", entityType: "agent_deployment", entityId: row.id, summary: `Started deploying "${bp.blueprint.name}" v${bp.blueprint.version} to "${ws.name}"` });
  return row;
}

/* ── steps 3 & 5: client settings and overrides ───────────────────────── */

/** Only these parts of the agent may be customised per client. */
const OVERRIDABLE = [
  "modules.ideation.enabled", "modules.ideation.batchSize", "modules.ideation.refresh",
  "modules.editing.enabled", "modules.editing.mode", "modules.editing.rules", "modules.editing.audio", "modules.editing.captions",
  "modules.editing.branding", "modules.editing.transitions", "modules.editing.shorts", "modules.editing.presets",
  "modules.publishing.enabled", "modules.publishing.mode", "modules.publishing.defaultPrivacy", "modules.publishing.categoryId",
  "modules.publishing.madeForKids", "modules.publishing.uploadCaptions", "modules.publishing.rules",
  "models.llm.preferences", "models.llm.effort", "models.transcription.preferences", "models.transcription.language", "models.transcription.diarization",
  "seo", "approvalGates",
];

export function assertOverridable(overrides: unknown, prefix = ""): void {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return;
  for (const [k, v] of Object.entries(overrides as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (OVERRIDABLE.includes(path)) continue;
    if (OVERRIDABLE.some((o) => o.startsWith(`${path}.`)) && v && typeof v === "object" && !Array.isArray(v)) { assertOverridable(v, path); continue; }
    throw validationError(`"${path}" cannot be overridden per client; change it in the blueprint instead.`);
  }
}

export async function saveClientConfiguration(ws: WorkspaceCtx, input: { profile?: z.infer<typeof profileInput>; overrides?: Record<string, unknown>; step?: number }) {
  const d = await requireDeployment(ws);
  if (input.profile) await updateProfile(ws, input.profile);
  if (input.overrides) {
    assertOverridable(input.overrides);
    const { bp } = await versionContent(d.blueprintVersionId);
    mergeConfig(bp.config, input.overrides); // throws on an invalid combination
  }
  await db.update(agentDeployments).set({
    ...(input.overrides ? { overrides: input.overrides } : {}),
    ...(input.step ? { wizardStep: Math.max(d.wizardStep, input.step) } : {}),
    ...(d.status === "active" ? {} : { validation: null }),
    updatedAt: new Date(),
  }).where(eq(agentDeployments.id, d.id));
  if (d.status === "active" && input.overrides) await recordRevision(ws, d.id, "Edited client configuration");
  await auditWs(ws, { action: "deployment.configure", entityType: "agent_deployment", entityId: d.id, summary: "Updated client agent configuration" });
}

/* ── step 4: bind logical integrations to this client's connections ───── */

export async function bindIntegration(ws: WorkspaceCtx, ref: string, connectionId: string | null) {
  const d = await requireDeployment(ws);
  const { bp } = await versionContent(d.blueprintVersionId);
  const spec = bp.config.integrations.find((i) => i.ref === ref);
  if (!spec) throw validationError(`The blueprint has no integration "${ref}".`);
  const bindings = { ...(d.bindings as Record<string, string>) };
  if (connectionId) {
    const c = (await listConnections(ws)).find((x) => x.id === connectionId);
    if (!c) throw notFound("Connection not found in this workspace.");
    if (c.kind !== spec.kind) throw validationError(`"${ref}" needs a ${spec.kind} connection.`);
    bindings[ref] = c.id;
  } else delete bindings[ref];
  await db.update(agentDeployments).set({ bindings, updatedAt: new Date(), ...(d.status === "active" ? {} : { validation: null }) }).where(eq(agentDeployments.id, d.id));
  if (d.status === "active") await recordRevision(ws, d.id, `Rebound ${ref}`);
  await auditWs(ws, { action: "deployment.bind", entityType: "agent_deployment", entityId: d.id, summary: connectionId ? `Bound ${ref}` : `Unbound ${ref}` });
}

/* ── step 6: validation ───────────────────────────────────────────────── */

export async function validateDeployment(ws: WorkspaceCtx): Promise<{ ok: boolean; checks: Check[] }> {
  const d = await requireDeployment(ws);
  const { row, bp } = await versionContent(d.blueprintVersionId);
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  let config: AgentConfig | null = null;
  try {
    config = mergeConfig(bp.config, d.overrides);
    add({ id: "config", label: "Agent configuration", status: "pass", message: `${bp.blueprint.name} v${row.version} with ${Object.keys(d.overrides as object).length} client override group(s).` });
  } catch (e) {
    add({ id: "config", label: "Agent configuration", status: "fail", message: e instanceof Error ? e.message : "Invalid" });
  }

  const profile = await getProfile(ws);
  for (const field of bp.config.requiredClientSettings) {
    const v = profile[field as keyof typeof profile];
    const filled = Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : v != null;
    add({ id: `profile.${field}`, label: `Profile: ${field}`, status: filled ? "pass" : "fail", message: filled ? "Provided." : "Required by this blueprint. Fill it in on the creator profile step." });
  }

  if (config) {
    for (const i of config.integrations) {
      const label = `${i.ref} (${i.kind})`;
      if (i.kind === "storage") {
        const c = await resolveConnection(ws, i.ref, "storage");
        add({ id: `int.${i.ref}`, label, status: "pass", message: c ? `Client bucket "${c.externalAccountName}".` : "Installation default storage." });
        continue;
      }
      if (i.kind === "youtube") {
        const c = await resolveConnection(ws, i.ref, "youtube");
        if (!c) { add({ id: `int.${i.ref}`, label, status: i.required ? "fail" : "warn", message: "No YouTube channel connected. Connect the client's own channel." }); continue; }
        const needed = (i.scopes ?? []).filter((s) => !(s === "youtube.upload" && !config!.modules.publishing.enabled));
        const missing = needed.filter((s) => !c.scopes.includes(s));
        add({ id: `int.${i.ref}`, label, status: c.status === "error" ? "fail" : missing.length ? (missing.includes("youtube.upload") || missing.includes("youtube.readonly") ? "fail" : "warn") : "pass", message: c.status === "error" ? (c.lastError ?? "Needs reconnecting.") : missing.length ? `"${c.externalAccountName}" is missing scopes: ${missing.join(", ")}. Reconnect and grant them.` : `"${c.externalAccountName}" with ${c.scopes.join(", ")}.` });
        continue;
      }
      try {
        const p = i.kind === "llm" ? await getLlm(ws, config.models.llm) : await getTranscriber(ws, config.models.transcription);
        add({ id: `int.${i.ref}`, label, status: p.isMock ? "warn" : "pass", message: p.isMock ? "Mock provider (test environments only)." : `${p.provider} / ${p.model}` });
      } catch (e) {
        add({ id: `int.${i.ref}`, label, status: i.required ? "fail" : "warn", message: e instanceof AppError ? e.message : "Not configured." });
      }
    }
    const ff = await ffVersions();
    if (config.capabilities.includes("ffmpeg") || config.capabilities.includes("ffprobe")) {
      add({ id: "cap.ffmpeg", label: "FFmpeg / FFprobe", status: ff.ffmpeg && ff.ffprobe ? "pass" : "fail", message: ff.ffmpeg && ff.ffprobe ? ff.ffmpeg : "FFmpeg is not available to the worker." });
    }
    for (const wf of config.workflows) {
      const errs = validateWorkflow(wf).filter((x) => x.level === "error");
      add({ id: `wf.${wf.key}`, label: `Workflow: ${wf.name}`, status: errs.length ? "fail" : "pass", message: errs.length ? errs.map((e) => e.message).join(" ") : `${wf.nodes.length} steps.` });
    }
    if (config.modules.publishing.enabled && config.modules.publishing.mode === "rule_based" && !ws.settings.autoPublishAuthorized) {
      add({ id: "publish.auth", label: "Rule-based publishing", status: "warn", message: "The workspace owner has not authorised automatic publishing; uploads will wait for approval." });
    }
  }
  const missingEnv = bp.config.env.filter((e) => e.required && !process.env[e.name]).map((e) => e.name);
  add({ id: "env", label: "Installation environment", status: missingEnv.length ? "warn" : "pass", message: missingEnv.length ? `Not set on this installation: ${missingEnv.join(", ")}.` : "All required variables are set." });

  const ok = !checks.some((c) => c.status === "fail");
  await db.update(agentDeployments).set({ validation: { ok, checks, at: new Date().toISOString() }, ...(d.status === "draft" && ok ? { status: "ready" } : d.status === "ready" && !ok ? { status: "draft" } : {}), wizardStep: Math.max(d.wizardStep, 7) }).where(eq(agentDeployments.id, d.id));
  return { ok, checks };
}

/* ── step 7: live checks and a dry run ────────────────────────────────── */

/**
 * Tests each resolved connection against its provider, exercises the media
 * pipeline on a generated clip, and dry-runs every workflow's branching
 * against this client's configuration. No client content is touched and
 * nothing is published.
 */
export async function testDeployment(ws: WorkspaceCtx) {
  const d = await requireDeployment(ws);
  const { bp } = await versionContent(d.blueprintVersionId);
  const config = mergeConfig(bp.config, d.overrides);
  const results: Check[] = [];

  const seen = new Set<string>();
  for (const i of config.integrations) {
    const c = await resolveConnection(ws, i.ref, i.kind);
    if (!c || seen.has(c.id)) continue;
    seen.add(c.id);
    const r = await testConnection(ws, c.id);
    results.push({ id: `conn.${c.id}`, label: `${i.ref}: ${c.label}`, status: r.ok ? "pass" : "fail", message: r.message });
  }

  const work = join(process.env.SCRATCH_DIR ?? ".scratch", "deploy-test", randomUUID());
  await mkdir(work, { recursive: true });
  try {
    const clip = join(work, "test.mp4");
    await ffmpeg(["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2", "-af", "apad=whole_dur=3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", clip]);
    const p = await probe(clip);
    const sil = await detectSilences(clip, config.modules.editing.rules.silenceNoiseDb, 0.5);
    results.push({ id: "media", label: "Media pipeline (FFmpeg)", status: p.hasVideo && p.hasAudio && sil.length > 0 ? "pass" : "fail", message: `Generated a ${p.duration.toFixed(1)}s test clip, probed it and detected ${sil.length} silence range(s).` });
  } catch (e) {
    results.push({ id: "media", label: "Media pipeline (FFmpeg)", status: "fail", message: e instanceof Error ? e.message : "FFmpeg test failed" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  for (const wf of config.workflows) {
    const order = topoSort(wf.nodes) ?? [];
    const runs: string[] = [], skips: string[] = [];
    const statuses: Record<string, { status: string }> = {};
    for (const id of order) {
      const node = wf.nodes.find((n) => n.id === id)!;
      const upstreamSkipped = node.dependsOn.length > 0 && JSON.stringify(node.config).match(/steps\.([a-z0-9_]+)\./g)?.some((m) => statuses[m.split(".")[1]]?.status === "skipped");
      const cond = node.when ? evaluate(node.when, { config, input: {}, steps: statuses }) : true;
      const status = !upstreamSkipped && cond ? "would run" : "skipped";
      statuses[id] = { status: status === "skipped" ? "skipped" : "succeeded" };
      (status === "skipped" ? skips : runs).push(node.label ?? nodeSpec(node.type)?.label ?? node.type);
    }
    results.push({ id: `dry.${wf.key}`, label: `Dry run: ${wf.name}`, status: "pass", message: `Would run: ${runs.join(" → ") || "nothing"}.${skips.length ? ` Skipped for this client: ${skips.join(", ")}.` : ""}` });
  }

  await db.update(agentDeployments).set({ testResults: { results, at: new Date().toISOString() }, wizardStep: Math.max(d.wizardStep, 8) }).where(eq(agentDeployments.id, d.id));
  return results;
}

/* ── step 8: differences from the blueprint ───────────────────────────── */

export async function deploymentDiff(ws: WorkspaceCtx) {
  const d = await requireDeployment(ws);
  const { bp } = await versionContent(d.blueprintVersionId);
  return { diff: jsonDiff(bp.config, mergeConfig(bp.config, d.overrides)), bindings: d.bindings as Record<string, string> };
}

/* ── step 9: activation, updates, rollback ────────────────────────────── */

async function recordRevision(ws: WorkspaceCtx, deploymentId: string, reason: string) {
  const [d] = await db.select().from(agentDeployments).where(eq(agentDeployments.id, deploymentId));
  const { bp } = await versionContent(d.blueprintVersionId);
  const effective = mergeConfig(bp.config, d.overrides);
  const revision = d.currentRevision + 1;
  await db.insert(deploymentRevisions).values({ workspaceId: ws.workspaceId, deploymentId, revision, blueprintVersionId: d.blueprintVersionId, overrides: d.overrides, bindings: d.bindings, effectiveConfig: effective, reason, createdBy: ws.actorId });
  await db.update(agentDeployments).set({ currentRevision: revision }).where(eq(agentDeployments.id, deploymentId));
  return revision;
}

export async function activateDeployment(ws: WorkspaceCtx) {
  const d = await requireDeployment(ws);
  const v = await validateDeployment(ws);
  if (!v.ok) throw validationError("Some checks failed. Fix them before activating.", { checks: v.checks.filter((c) => c.status === "fail") });
  await db.update(agentDeployments).set({ status: "active", activatedAt: new Date(), activatedBy: ws.actorId, wizardStep: 9, updatedAt: new Date() }).where(eq(agentDeployments.id, d.id));
  const revision = await recordRevision(ws, d.id, d.activatedAt ? "Re-activated" : "Activated");
  await auditWs(ws, { action: "deployment.activate", entityType: "agent_deployment", entityId: d.id, summary: `Activated the agent (revision ${revision})` });
  return revision;
}

export async function setPaused(ws: WorkspaceCtx, paused: boolean) {
  const d = await requireDeployment(ws);
  if (paused && d.status !== "active") throw conflict("Only an active agent can be paused.");
  if (!paused) return activateDeployment(ws);
  await db.update(agentDeployments).set({ status: "paused", updatedAt: new Date() }).where(eq(agentDeployments.id, d.id));
  await auditWs(ws, { action: "deployment.pause", entityType: "agent_deployment", entityId: d.id, summary: "Paused the agent" });
}

/** Newer versions of the same template. Nothing is applied until someone reviews and applies one. */
export async function availableUpdates(ws: WorkspaceCtx) {
  const d = await requireDeployment(ws);
  const { row: current } = await versionContent(d.blueprintVersionId);
  const all = await db.select().from(blueprintVersions).where(eq(blueprintVersions.templateId, d.templateId));
  return all.filter((v) => v.status === "active" && compareSemver(v.version, current.version) > 0).sort((a, b) => compareSemver(b.version, a.version));
}

export async function previewVersionChange(ws: WorkspaceCtx, targetVersionId: string) {
  const d = await requireDeployment(ws);
  const [target] = await db.select().from(blueprintVersions).where(and(eq(blueprintVersions.id, targetVersionId), eq(blueprintVersions.templateId, d.templateId))).limit(1);
  if (!target) throw notFound("That version does not belong to this agent's template.");
  const { bp: currentBp } = await versionContent(d.blueprintVersionId);
  const nextBp = blueprintSchema.parse(target.content);
  const before = mergeConfig(currentBp.config, d.overrides);
  let after: AgentConfig | null = null, problem: string | null = null;
  try { after = mergeConfig(nextBp.config, d.overrides); } catch (e) { problem = e instanceof Error ? e.message : "Overrides are incompatible with this version."; }
  const newIntegrations = nextBp.config.integrations.filter((i) => !currentBp.config.integrations.some((c) => c.ref === i.ref)).map((i) => i.ref);
  return { target, diff: after ? jsonDiff(before, after) : [], problem, newIntegrations, changelog: nextBp.blueprint.changelog, unchanged: after ? deepEqual(before, after) : false };
}

/** Moves the deployment to another version of its template (upgrade or downgrade), keeping overrides. */
export async function applyVersion(ws: WorkspaceCtx, targetVersionId: string) {
  const preview = await previewVersionChange(ws, targetVersionId);
  if (preview.problem) throw validationError(`Cannot apply: ${preview.problem}`);
  const d = await requireDeployment(ws);
  await db.update(agentDeployments).set({ blueprintVersionId: targetVersionId, updatedAt: new Date() }).where(eq(agentDeployments.id, d.id));
  const revision = await recordRevision(ws, d.id, `Applied blueprint v${preview.target.version}`);
  if (d.status === "active") {
    const v = await validateDeployment(ws);
    if (!v.ok) await db.update(agentDeployments).set({ status: "paused" }).where(eq(agentDeployments.id, d.id));
  }
  await auditWs(ws, { action: "deployment.update", entityType: "agent_deployment", entityId: d.id, summary: `Applied blueprint v${preview.target.version} (revision ${revision})` });
  return revision;
}

export async function listRevisions(ws: WorkspaceCtx) {
  const d = await requireDeployment(ws);
  return db.select({ r: deploymentRevisions, version: blueprintVersions.version }).from(deploymentRevisions)
    .innerJoin(blueprintVersions, eq(blueprintVersions.id, deploymentRevisions.blueprintVersionId))
    .where(eq(deploymentRevisions.deploymentId, d.id)).orderBy(desc(deploymentRevisions.revision));
}

/** Restores the exact blueprint version, overrides and bindings of an earlier revision. */
export async function rollback(ws: WorkspaceCtx, revision: number) {
  const d = await requireDeployment(ws);
  const [r] = await db.select().from(deploymentRevisions).where(and(eq(deploymentRevisions.deploymentId, d.id), eq(deploymentRevisions.revision, revision))).limit(1);
  if (!r) throw notFound("Revision not found.");
  const { bp } = await versionContent(r.blueprintVersionId);
  mergeConfig(bp.config, r.overrides);
  await db.update(agentDeployments).set({ blueprintVersionId: r.blueprintVersionId, overrides: r.overrides, bindings: r.bindings, updatedAt: new Date() }).where(eq(agentDeployments.id, d.id));
  const next = await recordRevision(ws, d.id, `Rolled back to revision ${revision}`);
  await auditWs(ws, { action: "deployment.rollback", entityType: "agent_deployment", entityId: d.id, summary: `Rolled back to revision ${revision} (now revision ${next})` });
  return next;
}
