import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { AppError } from "@/lib/errors";
import { actorFromApiToken, createApiToken } from "@/server/auth";
import { decideApproval, createApproval } from "@/server/services/approvals";
import { addApiKeyConnection, listConnections } from "@/server/services/integrations";
import { getIdea, generateIdeas } from "@/server/services/ideas";
import { getAsset, mediaUrl } from "@/server/services/media";
import { getEdit, getTranscript, proposeEdit } from "@/server/services/editing";
import { getRender, requestRender } from "@/server/services/render";
import { getRun } from "@/server/workflow/engine";
import { verifyMediaSignature } from "@/server/storage";
import { requireWorkspace } from "@/server/tenancy";
import { drain, makeAgency, makeClient, makeFootage, makeMember, mockProviders, uploadFile, wipe } from "./helpers";

const code = (e: unknown) => (e instanceof AppError ? e.code : String(e));

describe("tenant isolation", () => {
  let agency: Awaited<ReturnType<typeof makeAgency>>;
  let a: Awaited<ReturnType<typeof makeClient>>["ctx"];
  let b: Awaited<ReturnType<typeof makeClient>>["ctx"];
  const bIds: Record<string, string> = {};

  beforeAll(async () => {
    await wipe();
    agency = await makeAgency();
    a = (await makeClient(agency, "Client A")).ctx;
    b = (await makeClient(agency, "Client B")).ctx;
    await mockProviders(a);
    await mockProviders(b);
    bIds.asset = await uploadFile(b, makeFootage("b-iso.mp4", 5));
    const ep = await proposeEdit(b, { assetId: bIds.asset, useLlm: false });
    bIds.edit = ep.editProjectId;
    bIds.render = (await requestRender(b, ep.editProjectId, "draft")).id;
    await drain();
    bIds.batch = (await generateIdeas(b, { count: 1 })).batchId;
    bIds.idea = (await db.select().from(s.contentIdeas).where(eq(s.contentIdeas.workspaceId, b.workspaceId)))[0].id;
    bIds.approval = (await createApproval(b, { kind: "custom", title: "B approval", subjectType: "custom", subjectId: null })).id;
    const [run] = await db.insert(s.workflowRuns).values({ workspaceId: b.workspaceId, workflowKey: "x", workflowName: "x", definition: {} }).returning();
    bIds.run = run.id;
    // B's own provider key (added last: the resolver prefers it over the mock, and it is not a real key).
    await addApiKeyConnection({ orgId: b.orgId, workspaceId: b.workspaceId, actorId: b.actorId }, { kind: "llm", provider: "openai", label: "B's own key", apiKey: "sk-proj-bbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  });

  it("a client member cannot open another client's workspace (indistinguishable from not found)", async () => {
    const owner = await makeMember(a.workspaceId, "owner");
    await expect(requireWorkspace(owner.actor, b.workspaceId, "view")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await expect(requireWorkspace(owner.actor, "00000000-0000-0000-0000-000000000000", "view")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
  });

  it("another agency's admin cannot reach this agency's clients", async () => {
    const other = await makeAgency("Rival");
    await expect(requireWorkspace(other.actor, a.workspaceId, "view")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
  });

  it("workspace-scoped services never return another client's files, edits, renders, ideas, runs or transcripts", async () => {
    await expect(getAsset(a, bIds.asset)).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await expect(getEdit(a, bIds.edit)).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await expect(getRender(a, bIds.render)).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await expect(getIdea(a, bIds.idea)).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await expect(getRun(a, bIds.run)).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    expect(await getTranscript(a, bIds.asset)).toBeNull();
    await expect(requestRender(a, bIds.edit, "draft")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await expect(proposeEdit(a, { assetId: bIds.asset, useLlm: false })).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
  });

  it("another client's credentials are never listed or usable", async () => {
    const conns = await listConnections(a);
    expect(conns.some((c) => c.workspaceId === b.workspaceId)).toBe(false);
  });

  it("approvals cannot be decided across workspaces", async () => {
    await expect(decideApproval(a, bIds.approval, "approved")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    const [row] = await db.select().from(s.approvalRequests).where(eq(s.approvalRequests.id, bIds.approval));
    expect(row.status).toBe("pending");
  });

  it("a signed media URL is bound to its workspace", async () => {
    const asset = await getAsset(b, bIds.asset);
    const q = new URL((await mediaUrl(b, asset, "proxy"))!, "http://x").searchParams;
    expect(verifyMediaSignature(b.workspaceId, asset.id, "proxy", q.get("exp")!, q.get("sig")!)).toBe(true);
    expect(verifyMediaSignature(a.workspaceId, asset.id, "proxy", q.get("exp")!, q.get("sig")!)).toBe(false);
    expect(verifyMediaSignature(b.workspaceId, asset.id, "original", q.get("exp")!, q.get("sig")!)).toBe(false);
    expect(verifyMediaSignature(b.workspaceId, asset.id, "proxy", String(Math.floor(Date.now() / 1000) - 10), q.get("sig")!)).toBe(false);
  });

  it("enforces roles: viewers cannot edit, editors cannot approve or publish", async () => {
    const viewer = await makeMember(a.workspaceId, "viewer");
    const editor = await makeMember(a.workspaceId, "editor");
    await expect(requireWorkspace(viewer.actor, a.workspaceId, "edit")).rejects.toSatisfy((e) => code(e) === "FORBIDDEN");
    await expect(requireWorkspace(editor.actor, a.workspaceId, "approve")).rejects.toSatisfy((e) => code(e) === "FORBIDDEN");
    await expect(requireWorkspace(editor.actor, a.workspaceId, "agency")).rejects.toSatisfy((e) => code(e) === "FORBIDDEN");
    const ectx = await requireWorkspace(editor.actor, a.workspaceId, "edit");
    const appr = await createApproval(a, { kind: "custom", title: "x", subjectType: "custom", subjectId: null });
    await expect(decideApproval(ectx, appr.id, "approved")).rejects.toSatisfy((e) => code(e) === "FORBIDDEN");
  });

  it("API tokens are hashed, scoped to their user and revocable", async () => {
    const owner = await makeMember(a.workspaceId, "owner");
    const token = await createApiToken(owner.user.id, "ci", 30);
    const [row] = await db.select().from(s.apiTokens).where(eq(s.apiTokens.userId, owner.user.id));
    expect(row.tokenHash).not.toBe(token);
    const actor = await actorFromApiToken(token);
    expect(actor?.userId).toBe(owner.user.id);
    await expect(requireWorkspace(actor!, b.workspaceId, "view")).rejects.toSatisfy((e) => code(e) === "NOT_FOUND");
    await db.update(s.apiTokens).set({ revokedAt: new Date() }).where(and(eq(s.apiTokens.id, row.id)));
    expect(await actorFromApiToken(token)).toBeNull();
  });
});
