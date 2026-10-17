import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { orgMemberships, organizations, workspaceMemberships, workspaces } from "@/db/schema";
import { forbidden, notFound } from "@/lib/errors";
import { parseWorkspaceSettings, type WorkspaceSettings } from "@/lib/settings";
import type { Actor } from "./auth";

/**
 * Tenant isolation.
 *
 * Every workspace-scoped operation starts by calling `requireWorkspace`, which
 * proves the actor may act on that workspace with at least the given
 * permission and returns a `WorkspaceCtx`. Services take that context and
 * filter every query by `ctx.workspaceId` — there is no service function that
 * accepts a bare record id without the workspace it must belong to.
 *
 * Hiding UI is never the boundary: these checks run on every server action,
 * API route and page load.
 */

export type EffectiveRole = "agency_admin" | "owner" | "editor" | "viewer";

export type Permission =
  | "view"            // read anything in the workspace
  | "edit"            // ideas, uploads, edits, profile, run workflows
  | "approve"         // approve edits/publishing, connect accounts, workspace settings, members
  | "agency";         // deployments, blueprint changes, data deletion

const RANK: Record<EffectiveRole, number> = { viewer: 0, editor: 1, owner: 2, agency_admin: 3 };
const NEEDS: Record<Permission, number> = { view: 0, edit: 1, approve: 2, agency: 3 };

export type WorkspaceCtx = {
  workspaceId: string;
  orgId: string;
  workspaceName: string;
  timezone: string;
  status: "active" | "archived";
  ownershipMode: "agency_managed" | "client_owned";
  settings: WorkspaceSettings;
  role: EffectiveRole;
  /** null for background jobs acting on the workspace's behalf. */
  actorId: string | null;
};

export function can(role: EffectiveRole, p: Permission): boolean {
  return RANK[role] >= NEEDS[p];
}

export async function roleIn(actor: Actor, workspace: { id: string; orgId: string }, conn: DbOrTx = db): Promise<EffectiveRole | null> {
  if (actor.orgs.some((o) => o.orgId === workspace.orgId && o.role === "admin")) return "agency_admin";
  const [m] = await conn.select({ role: workspaceMemberships.role }).from(workspaceMemberships)
    .where(and(eq(workspaceMemberships.workspaceId, workspace.id), eq(workspaceMemberships.userId, actor.userId))).limit(1);
  return m?.role ?? null;
}

export async function requireWorkspace(actor: Actor, workspaceId: string, permission: Permission, conn: DbOrTx = db): Promise<WorkspaceCtx> {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw notFound("Workspace not found.");
  const [ws] = await conn.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  // Same error for "missing" and "not yours", so ids cannot be probed.
  if (!ws) throw notFound("Workspace not found.");
  const role = await roleIn(actor, ws, conn);
  if (!role) throw notFound("Workspace not found.");
  if (!can(role, permission)) throw forbidden(permissionMessage(permission));
  if (ws.status === "archived" && permission !== "view" && permission !== "agency") throw forbidden("This workspace is archived. Restore it to make changes.");
  return toCtx(ws, role, actor.userId);
}

/** Context for background jobs, which act for the workspace without a user. */
export async function systemWorkspace(workspaceId: string, conn: DbOrTx = db): Promise<WorkspaceCtx> {
  const [ws] = await conn.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw notFound("Workspace not found.");
  return toCtx(ws, "owner", null);
}

function toCtx(ws: typeof workspaces.$inferSelect, role: EffectiveRole, actorId: string | null): WorkspaceCtx {
  return {
    workspaceId: ws.id, orgId: ws.orgId, workspaceName: ws.name, timezone: ws.timezone, status: ws.status,
    ownershipMode: ws.ownershipMode, settings: parseWorkspaceSettings(ws.settings), role, actorId,
  };
}

function permissionMessage(p: Permission): string {
  return {
    view: "You do not have access to this workspace.",
    edit: "Viewers cannot make changes. Ask a workspace owner for editor access.",
    approve: "Only the workspace owner (or an agency admin) can do that.",
    agency: "Only agency administrators can do that.",
  }[p];
}

/* ── organization level ───────────────────────────────────────────────── */

export type OrgCtx = { orgId: string; orgName: string; actorId: string; isAdmin: boolean };

/** The org the actor administers or belongs to (first membership). */
export async function primaryOrg(actor: Actor): Promise<OrgCtx | null> {
  const m = actor.orgs.find((o) => o.role === "admin") ?? actor.orgs[0];
  if (!m) return null;
  const [org] = await db.select().from(organizations).where(eq(organizations.id, m.orgId)).limit(1);
  return org ? { orgId: org.id, orgName: org.name, actorId: actor.userId, isAdmin: m.role === "admin" } : null;
}

export async function requireOrgAdmin(actor: Actor, orgId?: string): Promise<OrgCtx> {
  const target = orgId ?? actor.orgs.find((o) => o.role === "admin")?.orgId;
  if (!target || !actor.orgs.some((o) => o.orgId === target && o.role === "admin")) throw forbidden("Only agency administrators can do that.");
  const [org] = await db.select().from(organizations).where(eq(organizations.id, target)).limit(1);
  if (!org) throw notFound("Organization not found.");
  return { orgId: org.id, orgName: org.name, actorId: actor.userId, isAdmin: true };
}

/** Workspaces the actor can see: all in orgs they administer, plus explicit memberships. */
export async function accessibleWorkspaces(actor: Actor) {
  const adminOrgs = actor.orgs.filter((o) => o.role === "admin").map((o) => o.orgId);
  const viaOrg = adminOrgs.length ? await db.select().from(workspaces).where(inArray(workspaces.orgId, adminOrgs)) : [];
  const viaMembership = await db.select({ ws: workspaces, role: workspaceMemberships.role }).from(workspaceMemberships)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId)).where(eq(workspaceMemberships.userId, actor.userId));
  const map = new Map<string, { ws: typeof workspaces.$inferSelect; role: EffectiveRole }>();
  for (const ws of viaOrg) map.set(ws.id, { ws, role: "agency_admin" });
  for (const { ws, role } of viaMembership) if (!map.has(ws.id)) map.set(ws.id, { ws, role });
  return [...map.values()].sort((a, b) => a.ws.name.localeCompare(b.ws.name));
}

export async function isOrgMember(userId: string, orgId: string): Promise<boolean> {
  const [m] = await db.select({ u: orgMemberships.userId }).from(orgMemberships).where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId))).limit(1);
  return Boolean(m);
}
