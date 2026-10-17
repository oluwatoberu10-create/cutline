import "server-only";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { db } from "@/db";
import { apiTokens, orgMemberships, sessions, users } from "@/db/schema";
import { generateToken, hashToken } from "@/lib/crypto";
import { unauthenticated } from "@/lib/errors";

export const SESSION_COOKIE = "cl_session";
const SESSION_DAYS = 14;

export type User = typeof users.$inferSelect;

/**
 * The authenticated principal. Org roles come from the database on every
 * request, never from the cookie, so revoking access takes effect immediately.
 */
export type Actor = {
  userId: string;
  email: string;
  name: string;
  orgs: { orgId: string; role: "admin" | "member" }[];
  via: "session" | "api_token";
};

async function actorForUser(user: User, via: Actor["via"]): Promise<Actor | null> {
  if (user.status !== "active") return null;
  const orgs = await db.select({ orgId: orgMemberships.orgId, role: orgMemberships.role }).from(orgMemberships).where(eq(orgMemberships.userId, user.id));
  return { userId: user.id, email: user.email, name: user.name, orgs, via };
}

/* ── sessions ─────────────────────────────────────────────────────────── */

export async function createSession(userId: string): Promise<void> {
  const token = generateToken();
  const ua = (await headers()).get("user-agent")?.slice(0, 300) ?? null;
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 864e5);
  await db.insert(sessions).values({ userId, tokenHash: hashToken(token), expiresAt, userAgent: ua });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  jar.delete(SESSION_COOKIE);
}

async function actorFromSessionToken(token: string): Promise<Actor | null> {
  const [row] = await db.select({ user: users }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date()))).limit(1);
  return row ? actorForUser(row.user, "session") : null;
}

export async function actorFromApiToken(token: string): Promise<Actor | null> {
  if (!token.startsWith("cl_")) return null;
  const [row] = await db.select({ user: users, tokenId: apiTokens.id }).from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId))
    .where(and(eq(apiTokens.tokenHash, hashToken(token)), isNull(apiTokens.revokedAt), or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())))).limit(1);
  if (!row) return null;
  await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.tokenId));
  return actorForUser(row.user, "api_token");
}

/** The signed-in actor for pages and server actions (cookie session). */
export const getActor = cache(async (): Promise<Actor | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? actorFromSessionToken(token) : null;
});

/** For API routes: a Bearer API token, else the session cookie. */
export async function actorFromRequest(req: Request): Promise<Actor | null> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return actorFromApiToken(auth.slice(7).trim());
  return getActor();
}

export async function requireActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) throw unauthenticated();
  return a;
}

export async function pageActor(): Promise<Actor> {
  const a = await getActor();
  if (!a) redirect("/login");
  return a;
}

export function isOrgAdmin(actor: Actor, orgId: string): boolean {
  return actor.orgs.some((o) => o.orgId === orgId && o.role === "admin");
}

export async function createApiToken(userId: string, name: string, days: number | null): Promise<string> {
  const token = `cl_${generateToken(32)}`;
  await db.insert(apiTokens).values({
    userId, name, prefix: token.slice(0, 10), tokenHash: hashToken(token),
    expiresAt: days ? new Date(Date.now() + days * 864e5) : null,
  });
  return token;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim().slice(0, 64);
}
