import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { Actor } from "@/server/auth";
import { drain } from "@/server/jobs/worker";
import { addApiKeyConnection } from "@/server/services/integrations";
import { completeUpload, createUpload, receivePart } from "@/server/services/media";
import { createWorkspace } from "@/server/services/workspaces";
import { requireWorkspace, type OrgCtx, type WorkspaceCtx } from "@/server/tenancy";

/** Empties every table between test files. */
export async function wipe(): Promise<void> {
  const r = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = r.rows.map((x) => `"${x.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

let n = 0;

export async function makeUser(name = "User"): Promise<typeof s.users.$inferSelect> {
  n++;
  const [u] = await db.insert(s.users).values({ email: `${name.toLowerCase().replace(/\W/g, "")}${n}-${Date.now()}@test.local`, name, passwordHash: "x" }).returning();
  return u;
}

/** An agency with one admin. */
export async function makeAgency(name = "Agency") {
  const admin = await makeUser(`${name} Admin`);
  const [org] = await db.insert(s.organizations).values({ name, slug: `${name.toLowerCase()}-${++n}` }).returning();
  await db.insert(s.orgMemberships).values({ orgId: org.id, userId: admin.id, role: "admin" });
  const actor: Actor = { userId: admin.id, email: admin.email, name: admin.name, orgs: [{ orgId: org.id, role: "admin" }], via: "session" };
  const orgCtx: OrgCtx = { orgId: org.id, orgName: org.name, actorId: admin.id, isAdmin: true };
  return { org, admin, actor, orgCtx };
}

export async function makeClient(agency: Awaited<ReturnType<typeof makeAgency>>, name: string) {
  const ws = await createWorkspace(agency.orgCtx, { name, timezone: "UTC", ownershipMode: "agency_managed" });
  const ctx = await requireWorkspace(agency.actor, ws.id, "agency");
  return { ws, ctx };
}

/** A user who is only a member of one workspace with the given role. */
export async function makeMember(workspaceId: string, role: "owner" | "editor" | "viewer") {
  const u = await makeUser(`${role} member`);
  await db.insert(s.workspaceMemberships).values({ workspaceId, userId: u.id, role });
  const actor: Actor = { userId: u.id, email: u.email, name: u.name, orgs: [], via: "session" };
  return { user: u, actor };
}

export async function mockProviders(ctx: WorkspaceCtx) {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId, actorId: ctx.actorId };
  await addApiKeyConnection(scope, { kind: "llm", provider: "mock", label: "Mock LLM" });
  await addApiKeyConnection(scope, { kind: "transcription", provider: "mock", label: "Mock STT" });
}

const FIX = ".scratch-test/fixtures";

/**
 * Real footage: a 12-second 640x360 test pattern with a tone that has two
 * genuine silent gaps (3.0–5.0s and 8.0–9.5s) for pause detection.
 */
export function makeFootage(name = "footage.mp4", seconds = 12): string {
  mkdirSync(FIX, { recursive: true });
  const out = join(FIX, name);
  const vol = "volume='if(between(t,3,5)+between(t,8,9.5),0,1)':eval=frame";
  const r = spawnSync("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=25:duration=${seconds}`, "-f", "lavfi", "-i", `sine=frequency=330:duration=${seconds}:sample_rate=48000`,
    "-af", vol, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr.slice(-500)}`);
  return out;
}

export function makeLogo(): string {
  mkdirSync(FIX, { recursive: true });
  const out = join(FIX, "logo.png");
  spawnSync("ffmpeg", ["-hide_banner", "-y", "-f", "lavfi", "-i", "color=c=red@1:s=200x80", "-frames:v", "1", out]);
  return out;
}

/** Uploads a local file through the real chunked-upload service and drains ingest. */
export async function uploadFile(ctx: WorkspaceCtx, path: string, role: "source" | "brand" | "intro" | "outro" = "source", filename?: string) {
  const bytes = readFileSync(path);
  const up = await createUpload(ctx, { filename: filename ?? path.split(/[\\/]/).pop()!, size: statSync(path).size, role });
  for (let p = 1; p <= up.totalParts; p++) {
    const chunk = bytes.subarray((p - 1) * up.chunkBytes, p * up.chunkBytes);
    await receivePart(ctx, up.uploadId, p, new Blob([new Uint8Array(chunk)]).stream());
  }
  const done = await completeUpload(ctx, up.uploadId);
  await drain();
  return done.assetId;
}

export { drain };
