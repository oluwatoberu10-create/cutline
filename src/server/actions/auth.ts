"use server";

import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { ActionState } from "@/lib/action-state";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { safeInternalPath } from "@/lib/utils";
import { clientIp, createApiToken, createSession, destroySession, getActor, requireActor } from "../auth";
import { audit, enforceRate } from "../services/audit";
import { acceptInvite, bootstrap, needsSetup, validatePassword } from "../services/workspaces";
import { act, str } from "./util";

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = str(fd, "email").toLowerCase();
  const password = String(fd.get("password") ?? "");
  const r = await act(async () => {
    await enforceRate(`login:${await clientIp()}`, 20, 600, "Too many sign-in attempts. Wait ten minutes and try again.");
    await enforceRate(`login-user:${email}`, 8, 600, "Too many attempts for this account. Wait ten minutes and try again.");
    const [u] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
    // Same message and similar work whether or not the account exists.
    const ok = u ? await verifyPassword(password, u.passwordHash) : (await hashPassword(password), false);
    if (!u || !ok || u.status !== "active") return { ok: false, error: "Email or password is incorrect." };
    await createSession(u.id);
  });
  if (r.ok) redirect(safeInternalPath(fd.get("next"), "/"));
  return r;
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function setupAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const r = await act(async () => {
    if (!(await needsSetup())) return { ok: false, error: "This installation is already set up. Sign in instead." };
    const { user } = await bootstrap({ orgName: str(fd, "orgName"), name: str(fd, "name"), email: str(fd, "email"), password: String(fd.get("password") ?? "") });
    await createSession(user.id);
  });
  if (r.ok) redirect("/agency");
  return r;
}

export async function acceptInviteAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const token = str(fd, "token");
  let dest = "/";
  const r = await act(async () => {
    await enforceRate(`invite:${await clientIp()}`, 20, 600);
    const actor = await getActor();
    const res = actor ? await acceptInvite(token, { existingUserId: actor.userId }) : await acceptInvite(token, { name: str(fd, "name"), password: String(fd.get("password") ?? "") });
    if (!actor) await createSession(res.userId);
    dest = res.workspaceId ? `/w/${res.workspaceId}` : "/agency";
  });
  if (r.ok) redirect(dest);
  return r;
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const actor = await requireActor();
    const [u] = await db.select().from(users).where(eq(users.id, actor.userId));
    if (!(await verifyPassword(String(fd.get("current") ?? ""), u.passwordHash))) return { ok: false, error: "Current password is incorrect." };
    const next = String(fd.get("next") ?? "");
    validatePassword(next);
    await db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, u.id));
    await audit({ orgId: actor.orgs[0]?.orgId ?? null, actorId: u.id, action: "user.password", entityType: "user", entityId: u.id, summary: "Changed password" });
    return "Password updated.";
  });
}

export async function createApiTokenAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const actor = await requireActor();
    const name = str(fd, "name").slice(0, 60) || "API token";
    const days = Number(str(fd, "days") || 90);
    const token = await createApiToken(actor.userId, name, days > 0 ? days : null);
    await audit({ orgId: actor.orgs[0]?.orgId ?? null, actorId: actor.userId, action: "api_token.create", entityType: "api_token", summary: `Created API token "${name}"` });
    return { message: "Token created. Copy it now — it will not be shown again.", data: { token } };
  });
}

export async function revokeApiTokenAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const actor = await requireActor();
    const { apiTokens } = await import("@/db/schema");
    const { and } = await import("drizzle-orm");
    await db.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, str(fd, "id")), eq(apiTokens.userId, actor.userId)));
    return "Token revoked.";
  });
}
