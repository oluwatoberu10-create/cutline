import "server-only";
import { and, count, desc, eq, gt, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  creatorProfiles, invites, jobs, mediaAssets, orgMemberships, organizations, publishingJobs, users, workspaceMemberships, workspaces,
  approvalRequests, agentDeployments, workflowRuns,
} from "@/db/schema";
import { generateToken, hashPassword, hashToken } from "@/lib/crypto";
import { conflict, forbidden, notFound, validationError } from "@/lib/errors";
import { parseOrgSettings, workspaceSettingsSchema, type WorkspaceSettings } from "@/lib/settings";
import type { OrgCtx, WorkspaceCtx } from "../tenancy";
import { audit, auditWs } from "./audit";
import { enqueue } from "../jobs/queue";

/* ── installation bootstrap ───────────────────────────────────────────── */

export async function needsSetup(): Promise<boolean> {
  const [r] = await db.select({ n: count() }).from(users);
  return Number(r.n) === 0;
}

/** First run only: creates the agency and its first administrator. */
export async function bootstrap(input: { orgName: string; name: string; email: string; password: string }) {
  if (!(await needsSetup())) throw conflict("This installation is already set up.");
  validatePassword(input.password);
  return db.transaction(async (tx) => {
    const [org] = await tx.insert(organizations).values({ name: input.orgName.trim(), slug: slugify(input.orgName) || "agency" }).returning();
    const [user] = await tx.insert(users).values({ email: input.email.trim().toLowerCase(), name: input.name.trim(), passwordHash: await hashPassword(input.password) }).returning();
    await tx.insert(orgMemberships).values({ orgId: org.id, userId: user.id, role: "admin" });
    await audit({ orgId: org.id, actorId: user.id, action: "org.bootstrap", entityType: "organization", entityId: org.id, summary: `Created agency "${org.name}"` }, tx);
    return { org, user };
  });
}

export function validatePassword(p: string) {
  if (p.length < 10) throw validationError("Passwords must be at least 10 characters.");
  if (p.length > 200) throw validationError("Password is too long.");
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
}

/* ── client workspaces ────────────────────────────────────────────────── */

export const workspaceInput = z.object({
  name: z.string().trim().min(2, "Name the client.").max(80),
  contactEmail: z.union([z.literal(""), z.email("Enter a valid email.")]).optional(),
  timezone: z.string().trim().min(1).max(60).default("UTC"),
  ownershipMode: z.enum(["agency_managed", "client_owned"]).default("agency_managed"),
});

export async function createWorkspace(org: OrgCtx, input: z.infer<typeof workspaceInput>) {
  const settingsDefaults = parseOrgSettings((await db.select({ s: organizations.settings }).from(organizations).where(eq(organizations.id, org.orgId)))[0]?.s);
  let slug = slugify(input.name) || "client";
  const taken = await db.select({ slug: workspaces.slug }).from(workspaces).where(and(eq(workspaces.orgId, org.orgId), ilike(workspaces.slug, `${slug}%`)));
  if (taken.some((t) => t.slug === slug)) slug = `${slug}-${taken.length + 1}`;
  try { Intl.DateTimeFormat(undefined, { timeZone: input.timezone }); } catch { throw validationError("Unknown timezone."); }

  return db.transaction(async (tx) => {
    const [ws] = await tx.insert(workspaces).values({
      orgId: org.orgId, name: input.name, slug, contactEmail: input.contactEmail || null, timezone: input.timezone, ownershipMode: input.ownershipMode,
      settings: workspaceSettingsSchema.parse({ limits: settingsDefaults.defaultLimits }),
    }).returning();
    await tx.insert(creatorProfiles).values({ workspaceId: ws.id });
    await audit({ orgId: org.orgId, workspaceId: ws.id, actorId: org.actorId, action: "workspace.create", entityType: "workspace", entityId: ws.id, summary: `Created client workspace "${ws.name}"` }, tx);
    return ws;
  });
}

export async function listWorkspaces(orgId: string, opts: { q?: string; status?: "active" | "archived" } = {}) {
  const conds = [eq(workspaces.orgId, orgId)];
  if (opts.status) conds.push(eq(workspaces.status, opts.status));
  if (opts.q) conds.push(or(ilike(workspaces.name, `%${opts.q}%`), ilike(workspaces.contactEmail, `%${opts.q}%`))!);
  const rows = await db.select({
    ws: workspaces,
    deploymentStatus: agentDeployments.status,
    pendingApprovals: sql<number>`(select count(*) from ${approvalRequests} a where a.workspace_id = ${workspaces.id} and a.status = 'pending')`,
    failedJobs: sql<number>`(select count(*) from ${jobs} j where j.workspace_id = ${workspaces.id} and j.status = 'failed' and j.finished_at > now() - interval '7 days')`,
    assets: sql<number>`(select count(*) from ${mediaAssets} m where m.workspace_id = ${workspaces.id} and m.role = 'source' and m.deleted_at is null)`,
  }).from(workspaces).leftJoin(agentDeployments, eq(agentDeployments.workspaceId, workspaces.id))
    .where(and(...conds)).orderBy(workspaces.name);
  return rows.map((r) => ({ ...r, pendingApprovals: Number(r.pendingApprovals), failedJobs: Number(r.failedJobs), assets: Number(r.assets) }));
}

export async function updateWorkspace(ws: WorkspaceCtx, input: { name?: string; contactEmail?: string | null; timezone?: string }) {
  if (input.timezone) { try { Intl.DateTimeFormat(undefined, { timeZone: input.timezone }); } catch { throw validationError("Unknown timezone."); } }
  await db.update(workspaces).set({
    ...(input.name ? { name: input.name.trim().slice(0, 80) } : {}),
    ...(input.contactEmail !== undefined ? { contactEmail: input.contactEmail || null } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
  }).where(eq(workspaces.id, ws.workspaceId));
  await auditWs(ws, { action: "workspace.update", entityType: "workspace", entityId: ws.workspaceId, summary: "Updated workspace details" });
}

export async function updateWorkspaceSettings(ws: WorkspaceCtx, patch: Partial<WorkspaceSettings>) {
  const next = workspaceSettingsSchema.parse({ ...ws.settings, ...patch, limits: { ...ws.settings.limits, ...(patch.limits ?? {}) }, retention: { ...ws.settings.retention, ...(patch.retention ?? {}) } });
  if (patch.autoPublishAuthorized !== undefined && patch.autoPublishAuthorized !== ws.settings.autoPublishAuthorized && ws.role !== "owner" && ws.role !== "agency_admin") {
    throw forbidden("Only the workspace owner can authorise rule-based publishing.");
  }
  await db.update(workspaces).set({ settings: next }).where(eq(workspaces.id, ws.workspaceId));
  await auditWs(ws, {
    action: patch.autoPublishAuthorized !== undefined && patch.autoPublishAuthorized !== ws.settings.autoPublishAuthorized ? (patch.autoPublishAuthorized ? "publishing.authorize_auto" : "publishing.revoke_auto") : "workspace.settings",
    entityType: "workspace", entityId: ws.workspaceId, summary: "Updated workspace settings", metadata: { patch },
  });
  return next;
}

export async function setArchived(ws: WorkspaceCtx, archived: boolean) {
  await db.update(workspaces).set({ status: archived ? "archived" : "active", archivedAt: archived ? new Date() : null }).where(eq(workspaces.id, ws.workspaceId));
  if (archived) await db.update(agentDeployments).set({ status: "paused" }).where(and(eq(agentDeployments.workspaceId, ws.workspaceId), eq(agentDeployments.status, "active")));
  await auditWs(ws, { action: archived ? "workspace.archive" : "workspace.restore", entityType: "workspace", entityId: ws.workspaceId, summary: archived ? "Archived workspace (agent paused)" : "Restored workspace" });
}

/**
 * Permanently deletes a client's data. Media files are removed by a
 * background job first; database rows cascade from the workspace row.
 */
export async function scheduleWorkspaceDeletion(ws: WorkspaceCtx, confirmName: string) {
  if (confirmName.trim() !== ws.workspaceName) throw validationError("Type the workspace name exactly to confirm deletion.");
  await setArchived(ws, true);
  await enqueue({ type: "workspace.purge", workspaceId: ws.workspaceId, payload: { workspaceId: ws.workspaceId }, dedupeKey: `purge:${ws.workspaceId}`, maxAttempts: 5, timeoutSeconds: 3600, createdBy: ws.actorId });
  await auditWs(ws, { action: "workspace.delete_requested", entityType: "workspace", entityId: ws.workspaceId, summary: "Requested permanent deletion of all workspace data" });
}

/* ── creator profile ──────────────────────────────────────────────────── */

const list = z.array(z.string().trim().min(1).max(200)).max(30);
export const profileInput = z.object({
  niche: z.string().trim().max(300), targetAudience: z.string().trim().max(500),
  audienceProblems: list, audienceInterests: list, formats: list,
  preferredLengthMin: z.number().int().min(0).max(600).nullable(), preferredLengthMax: z.number().int().min(0).max(600).nullable(),
  tone: z.string().trim().max(300), goals: z.string().trim().max(1000), avoidTopics: list,
  competitorChannels: z.array(z.string().trim().max(200)).max(20), contentCategories: list,
  publishingFrequency: z.string().trim().max(100), brandVoice: z.string().trim().max(1000), savedPreferences: list,
}).partial();

export async function getProfile(ws: WorkspaceCtx) {
  const [p] = await db.select().from(creatorProfiles).where(eq(creatorProfiles.workspaceId, ws.workspaceId)).limit(1);
  if (p) return p;
  const [created] = await db.insert(creatorProfiles).values({ workspaceId: ws.workspaceId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(creatorProfiles).where(eq(creatorProfiles.workspaceId, ws.workspaceId)))[0];
}

export async function updateProfile(ws: WorkspaceCtx, input: z.infer<typeof profileInput>) {
  const data = profileInput.parse(input);
  if (data.preferredLengthMin != null && data.preferredLengthMax != null && data.preferredLengthMin > data.preferredLengthMax) throw validationError("Minimum length must not exceed maximum length.");
  await getProfile(ws);
  await db.update(creatorProfiles).set({ ...data, updatedAt: new Date() }).where(eq(creatorProfiles.workspaceId, ws.workspaceId));
  await auditWs(ws, { action: "profile.update", entityType: "creator_profile", entityId: ws.workspaceId, summary: "Updated creator profile" });
}

/* ── members & invites ────────────────────────────────────────────────── */

export async function workspaceMembers(ws: WorkspaceCtx) {
  return db.select({ userId: users.id, name: users.name, email: users.email, role: workspaceMemberships.role, status: users.status })
    .from(workspaceMemberships).innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(eq(workspaceMemberships.workspaceId, ws.workspaceId)).orderBy(users.name);
}

export async function createInvite(scope: { orgId: string; workspaceId: string | null; actorId: string }, input: { email: string; orgRole?: "admin" | "member"; workspaceRole?: "owner" | "editor" | "viewer" }) {
  const email = z.email().parse(input.email.trim().toLowerCase());
  if (!scope.workspaceId && !input.orgRole) throw validationError("Choose a role.");
  const token = generateToken(32);
  await db.insert(invites).values({
    orgId: scope.orgId, workspaceId: scope.workspaceId, email, orgRole: scope.workspaceId ? null : input.orgRole ?? null,
    workspaceRole: scope.workspaceId ? input.workspaceRole ?? "editor" : null, tokenHash: hashToken(token),
    createdBy: scope.actorId, expiresAt: new Date(Date.now() + 7 * 864e5),
  });
  await audit({ orgId: scope.orgId, workspaceId: scope.workspaceId, actorId: scope.actorId, action: "member.invite", entityType: "invite", summary: `Invited ${email}` });
  // No email service is assumed: the link is shown once to the inviter to share.
  return { token, path: `/invite/${token}` };
}

export async function inviteByToken(token: string) {
  const [inv] = await db.select().from(invites).where(and(eq(invites.tokenHash, hashToken(token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date()))).limit(1);
  return inv ?? null;
}

export async function acceptInvite(token: string, input: { name: string; password: string } | { existingUserId: string }) {
  const inv = await inviteByToken(token);
  if (!inv) throw notFound("This invite link is invalid or has expired.");
  return db.transaction(async (tx) => {
    let userId: string;
    if ("existingUserId" in input) {
      const [u] = await tx.select().from(users).where(eq(users.id, input.existingUserId)).limit(1);
      if (!u || u.email.toLowerCase() !== inv.email) throw forbidden("This invite was sent to a different email address.");
      userId = u.id;
    } else {
      validatePassword(input.password);
      const [existing] = await tx.select().from(users).where(sql`lower(${users.email}) = ${inv.email}`).limit(1);
      if (existing) throw conflict("An account with this email already exists. Sign in first, then open the invite link again.");
      const [u] = await tx.insert(users).values({ email: inv.email, name: input.name.trim().slice(0, 80), passwordHash: await hashPassword(input.password) }).returning();
      userId = u.id;
    }
    if (inv.workspaceId) {
      await tx.insert(workspaceMemberships).values({ workspaceId: inv.workspaceId, userId, role: inv.workspaceRole ?? "viewer" })
        .onConflictDoUpdate({ target: [workspaceMemberships.workspaceId, workspaceMemberships.userId], set: { role: inv.workspaceRole ?? "viewer" } });
    } else {
      await tx.insert(orgMemberships).values({ orgId: inv.orgId, userId, role: inv.orgRole ?? "member" })
        .onConflictDoUpdate({ target: [orgMemberships.orgId, orgMemberships.userId], set: { role: inv.orgRole ?? "member" } });
    }
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
    await audit({ orgId: inv.orgId, workspaceId: inv.workspaceId, actorId: userId, action: "member.join", entityType: "user", entityId: userId, summary: `${inv.email} accepted an invite` }, tx);
    return { userId, workspaceId: inv.workspaceId };
  });
}

export async function setMemberRole(ws: WorkspaceCtx, userId: string, role: "owner" | "editor" | "viewer" | null) {
  if (role === null) await db.delete(workspaceMemberships).where(and(eq(workspaceMemberships.workspaceId, ws.workspaceId), eq(workspaceMemberships.userId, userId)));
  else await db.update(workspaceMemberships).set({ role }).where(and(eq(workspaceMemberships.workspaceId, ws.workspaceId), eq(workspaceMemberships.userId, userId)));
  await auditWs(ws, { action: role ? "member.role" : "member.remove", entityType: "user", entityId: userId, summary: role ? `Changed a member's role to ${role}` : "Removed a member" });
}

/* ── agency overview (real counts only) ───────────────────────────────── */

export async function agencyOverview(orgId: string) {
  const wsIds = db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.orgId, orgId));
  const [[clients], [active], [processed], [pending], [failed], recentRuns] = await Promise.all([
    db.select({ n: count() }).from(workspaces).where(and(eq(workspaces.orgId, orgId), eq(workspaces.status, "active"))),
    db.select({ n: count() }).from(agentDeployments).where(and(eq(agentDeployments.orgId, orgId), eq(agentDeployments.status, "active"))),
    db.select({ n: count() }).from(mediaAssets).where(and(inArray(mediaAssets.workspaceId, wsIds), eq(mediaAssets.role, "render"), eq(mediaAssets.status, "ready"))),
    db.select({ n: count() }).from(approvalRequests).where(and(inArray(approvalRequests.workspaceId, wsIds), eq(approvalRequests.status, "pending"))),
    db.select({ n: count() }).from(jobs).where(and(inArray(jobs.workspaceId, wsIds), eq(jobs.status, "failed"))),
    db.select({ run: workflowRuns, ws: workspaces.name }).from(workflowRuns).innerJoin(workspaces, eq(workspaces.id, workflowRuns.workspaceId))
      .where(eq(workspaces.orgId, orgId)).orderBy(desc(workflowRuns.createdAt)).limit(8),
  ]);
  const published = await db.select({ n: count() }).from(publishingJobs).where(and(inArray(publishingJobs.workspaceId, wsIds), inArray(publishingJobs.status, ["published", "scheduled"])));
  return {
    clients: Number(clients.n), activeAgents: Number(active.n), videosRendered: Number(processed.n), pendingApprovals: Number(pending.n),
    failedJobs: Number(failed.n), published: Number(published[0].n), recentRuns,
  };
}
