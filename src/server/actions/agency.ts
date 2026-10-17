"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { organizations } from "@/db/schema";
import type { ActionState } from "@/lib/action-state";
import { parseOrgSettings } from "@/lib/settings";
import { requireActor } from "../auth";
import { audit } from "../services/audit";
import {
  archiveTemplate, confirmImport, createTemplate, duplicateTemplate, previewImport, publishVersion, updateTemplate,
} from "../services/blueprints";
import { startDeployment } from "../services/deployments";
import { addApiKeyConnection, disconnectShared, testSharedConnection } from "../services/integrations";
import { createInvite, createWorkspace, workspaceInput } from "../services/workspaces";
import { requireWorkspace } from "../tenancy";
import { act, bool, orgCtx, str } from "./util";

export async function createClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const r = await act(async () => {
    const org = await orgCtx();
    const ws = await createWorkspace(org, workspaceInput.parse({ name: str(fd, "name"), contactEmail: str(fd, "contactEmail"), timezone: str(fd, "timezone") || "UTC", ownershipMode: str(fd, "ownershipMode") || "agency_managed" }));
    id = ws.id;
  });
  if (r.ok && fd.get("then") === "deploy") redirect(`/agency/deploy?ws=${id}`);
  if (r.ok) redirect(`/w/${id}`);
  return r;
}

export async function archiveClientAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ctx = await requireWorkspace(await requireActor(), str(fd, "ws"), "agency");
    const { setArchived } = await import("../services/workspaces");
    await setArchived(ctx, fd.get("archive") === "true");
    return fd.get("archive") === "true" ? "Workspace archived and its agent paused." : "Workspace restored.";
  });
}

/* ── templates & blueprints ───────────────────────────────────────────── */

export async function createTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const r = await act(async () => { id = (await createTemplate(await orgCtx(), { name: str(fd, "name"), description: str(fd, "description"), fromVersionId: str(fd, "fromVersionId") || null })).id; });
  if (r.ok) redirect(`/agency/templates/${id}`);
  return r;
}

export async function saveTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const raw = str(fd, "config");
    let config: unknown;
    try { config = JSON.parse(raw); } catch { return { ok: false, error: "The configuration is not valid JSON." }; }
    await updateTemplate(await orgCtx(), str(fd, "id"), { name: str(fd, "name"), description: str(fd, "description"), config });
    return "Draft saved. Publish a version to make it deployable.";
  });
}

export async function duplicateTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const r = await act(async () => { id = (await duplicateTemplate(await orgCtx(), str(fd, "id"))).id; });
  if (r.ok) redirect(`/agency/templates/${id}`);
  return r;
}

export async function archiveTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const r = await act(async () => { await archiveTemplate(await orgCtx(), str(fd, "id")); });
  if (r.ok) redirect("/agency/templates");
  return r;
}

export async function publishVersionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const v = await publishVersion(await orgCtx(), str(fd, "id"), { bump: (str(fd, "bump") || "minor") as "minor", changelog: str(fd, "changelog") });
    return `Published version ${v.version}. Existing deployments keep their current version until you apply an update.`;
  });
}

export async function previewImportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a .json or .zip blueprint file." };
    if (file.size > 5 * 1024 * 1024) return { ok: false, error: "Blueprint packages are limited to 5 MB." };
    const plan = await previewImport(await orgCtx(), new Uint8Array(await file.arrayBuffer()), file.name);
    return { ok: true, data: { plan: JSON.stringify({ ...plan, report: { ...plan.report, blueprint: plan.report.blueprint ? { blueprint: plan.report.blueprint.blueprint, schemaVersion: plan.report.blueprint.schemaVersion } : null } }) } };
  });
}

export async function confirmImportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let tid = "";
  const r = await act(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose the same file again to confirm." };
    const res = await confirmImport(await orgCtx(), new Uint8Array(await file.arrayBuffer()), file.name, str(fd, "contentHash"), { asNewTemplate: bool(fd, "asNewTemplate") });
    tid = res.templateId;
  });
  if (r.ok) redirect(`/agency/templates/${tid}?imported=1`);
  return r;
}

/* ── deployment wizard entry ──────────────────────────────────────────── */

export async function startDeploymentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let wsId = str(fd, "workspaceId");
  const r = await act(async () => {
    const org = await orgCtx();
    if (wsId === "new") {
      wsId = (await createWorkspace(org, workspaceInput.parse({ name: str(fd, "newName"), contactEmail: str(fd, "newEmail"), timezone: str(fd, "timezone") || "UTC", ownershipMode: "agency_managed" }))).id;
    }
    await startDeployment(org, { blueprintVersionId: str(fd, "blueprintVersionId"), workspaceId: wsId });
  });
  if (r.ok) redirect(`/agency/deploy?ws=${wsId}&step=3`);
  return r;
}

/* ── shared integrations & org settings ───────────────────────────────── */

export async function addSharedProviderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const org = await orgCtx();
    await addApiKeyConnection({ orgId: org.orgId, workspaceId: null, actorId: org.actorId }, { kind: str(fd, "kind") as "llm", provider: str(fd, "provider"), label: str(fd, "label"), apiKey: str(fd, "apiKey"), model: str(fd, "model") || undefined });
    return "Added. Workspaces that allow agency providers can now use it.";
  });
}

export async function testSharedProviderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const r = await testSharedConnection((await orgCtx()).orgId, str(fd, "id"));
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message };
  });
}

export async function removeSharedProviderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const o = await orgCtx(); await disconnectShared(o.orgId, o.actorId, str(fd, "id")); return "Removed and the stored key destroyed."; });
}

export async function inviteAgencyMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const o = await orgCtx();
    const r = await createInvite({ orgId: o.orgId, workspaceId: null, actorId: o.actorId }, { email: str(fd, "email"), orgRole: (str(fd, "role") || "member") as "member" });
    return { message: "Invite created. Share the link with them (it expires in 7 days).", data: { link: r.path } };
  });
}

export async function saveOrgSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const o = await orgCtx();
    const [org] = await db.select().from(organizations).where(eq(organizations.id, o.orgId));
    const cur = parseOrgSettings(org.settings);
    const n = (k: string, d: number) => { const v = Number(str(fd, k)); return Number.isFinite(v) && str(fd, k) !== "" ? v : d; };
    const next = parseOrgSettings({
      defaultTimezone: str(fd, "defaultTimezone") || cur.defaultTimezone,
      defaultLimits: { maxUploadMb: n("maxUploadMb", cur.defaultLimits.maxUploadMb), monthlyRenderMinutes: n("monthlyRenderMinutes", cur.defaultLimits.monthlyRenderMinutes), monthlyTranscriptionMinutes: n("monthlyTranscriptionMinutes", cur.defaultLimits.monthlyTranscriptionMinutes), monthlyLlmCalls: n("monthlyLlmCalls", cur.defaultLimits.monthlyLlmCalls) },
      security: { sessionDays: n("sessionDays", cur.security.sessionDays), requireApprovalForPublishing: true },
    });
    await db.update(organizations).set({ name: str(fd, "name") || org.name, settings: next }).where(eq(organizations.id, o.orgId));
    await audit({ orgId: o.orgId, actorId: o.actorId, action: "org.settings", entityType: "organization", entityId: o.orgId, summary: "Updated agency settings" });
    return "Settings saved. New client workspaces start from these limits.";
  });
}
