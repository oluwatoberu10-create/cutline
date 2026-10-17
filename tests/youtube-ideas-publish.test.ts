import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { decrypt } from "@/server/secrets";
import { mockPromptLog } from "@/server/providers/mock";
import { analyzeChannel, syncChannel } from "@/server/services/channel";
import { decideApproval, listApprovals } from "@/server/services/approvals";
import { completeYouTubeOAuth, disconnect, startYouTubeOAuth } from "@/server/services/integrations";
import { generateIdeas, listIdeas, regenerateIdea, scheduleIdea, setIdeaStatus } from "@/server/services/ideas";
import { approveEdit, proposeEdit } from "@/server/services/editing";
import { createPublishingJob, getPublishing, submitPublishing } from "@/server/services/publishing";
import { requestRender } from "@/server/services/render";
import { updateWorkspaceSettings } from "@/server/services/workspaces";
import { createFakeYouTube, type FakeYouTube } from "./fake-youtube";
import { drain, makeAgency, makeClient, makeFootage, makeUser, mockProviders, uploadFile, wipe } from "./helpers";

describe("YouTube connection, channel intelligence, ideation and publishing (fake Google endpoints)", () => {
  let yt: FakeYouTube;
  let agency: Awaited<ReturnType<typeof makeAgency>>;
  let ctx: Awaited<ReturnType<typeof makeClient>>["ctx"];

  beforeAll(async () => {
    await wipe();
    yt = createFakeYouTube({ videos: 6 });
    vi.stubGlobal("fetch", yt.fetch);
    agency = await makeAgency();
    ({ ctx } = await makeClient(agency, "Espresso Creator"));
    await mockProviders(ctx);
  });
  afterAll(() => vi.unstubAllGlobals());

  it("connects a channel with OAuth state + PKCE; state is single-use and bound to the user", async () => {
    const url = new URL(await startYouTubeOAuth(ctx, ["yt-analytics.readonly", "youtube.upload"], `/w/${ctx.workspaceId}/integrations`));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const state = url.searchParams.get("state")!;

    const stranger = await makeUser("Stranger");
    await expect(completeYouTubeOAuth(stranger.id, state, "good-code")).rejects.toThrow(/different user/);
    // The failed attempt consumed the state: replay is impossible.
    const url2 = new URL(await startYouTubeOAuth(ctx, ["yt-analytics.readonly", "youtube.upload"], "/"));
    const r = await completeYouTubeOAuth(ctx.actorId!, url2.searchParams.get("state")!, "good-code");
    expect(r.channelTitle).toBe("Fake Espresso Channel");
    await expect(completeYouTubeOAuth(ctx.actorId!, url2.searchParams.get("state")!, "good-code")).rejects.toThrow(/expired/);

    const [conn] = await db.select().from(s.connections).where(and(eq(s.connections.workspaceId, ctx.workspaceId), eq(s.connections.kind, "youtube")));
    expect(conn.scopes).toEqual(expect.arrayContaining(["youtube.readonly", "yt-analytics.readonly", "youtube.upload"]));
    const [cred] = await db.select().from(s.credentials).where(eq(s.credentials.id, conn.credentialId!));
    expect(cred.ciphertext).not.toContain("ya29");
    expect(JSON.parse(decrypt(cred.ciphertext)).refresh_token).toBe("1//0fake-refresh");
  });

  it("syncs uploads, playlists and authorised analytics, and records what was unavailable", async () => {
    const r = await syncChannel(ctx, { maxVideos: 50 });
    expect(r.videosSynced).toBe(6);
    expect(r.analyticsAvailable).toBe(true);
    expect(r.access.comments.available).toBe(false);
    const vids = await db.select().from(s.videos).where(eq(s.videos.workspaceId, ctx.workspaceId));
    expect(vids.find((v) => v.youtubeVideoId === yt.videos[3].id)?.analytics).toMatchObject({ averageViewPercentage: 43 });
  });

  it("explains a missing analytics permission instead of failing", async () => {
    const fake = createFakeYouTube({ analytics: "forbidden" });
    vi.stubGlobal("fetch", fake.fetch);
    const r = await syncChannel(ctx, { maxVideos: 50 });
    expect(r.analyticsAvailable).toBe(false);
    expect(r.access.analytics.reason).toMatch(/refused/);
    vi.stubGlobal("fetch", yt.fetch);
  });

  it("separates measured findings from hypotheses and drops invented video references", async () => {
    const r = await analyzeChannel(ctx, { useLlm: true });
    const [a] = await db.select().from(s.channelAnalyses).where(eq(s.channelAnalyses.id, r.analysisId));
    const measured = a.measured as { topByViews: { youtubeId: string }[]; formatMix: { shorts: { count: number } } };
    expect(measured.topByViews[0].youtubeId).toBe(yt.videos[3].id);
    expect(measured.formatMix.shorts.count).toBe(1);
    const hyp = a.hypotheses as { items: { videoIds: string[] }[] };
    expect(hyp.items.flatMap((h) => h.videoIds)).not.toContain("NOT_A_REAL_VIDEO");
    expect(a.isMock).toBe(true);
  });

  it("generates grounded ideas, learns only from this workspace's feedback, and schedules approved ones", async () => {
    const other = (await makeClient(agency, "Other Creator")).ctx;
    await mockProviders(other);
    const [otherIdea] = await db.insert(s.contentIdeas).values({ workspaceId: other.workspaceId, title: "OTHER CLIENT SECRET TOPIC", concept: "x" }).returning();
    await setIdeaStatus(other, otherIdea.id, "rejected", "OTHER CLIENT PRIVATE FEEDBACK");

    const batch = await generateIdeas(ctx, { count: 3 });
    const ideas = await listIdeas(ctx, { batchId: batch.batchId });
    expect(ideas).toHaveLength(3);
    for (const i of ideas) expect(i.supportingVideoIds.every((v) => yt.videos.some((x) => x.id === v))).toBe(true);
    expect(ideas[0].supportingVideoIds).not.toContain("INVENTED_ID");

    await setIdeaStatus(ctx, ideas[0].id, "rejected", "Too advanced for my audience");
    await regenerateIdea(ctx, ideas[1].id, "Prefer shorter formats");
    const prompt = mockPromptLog[mockPromptLog.length - 1].prompt;
    expect(prompt).toContain("Too advanced for my audience");
    expect(prompt).not.toContain("OTHER CLIENT PRIVATE FEEDBACK");
    expect(prompt).not.toContain("OTHER CLIENT SECRET TOPIC");

    await expect(scheduleIdea(ctx, ideas[2].id, "2026-11-20")).rejects.toThrow(/approved/);
    await setIdeaStatus(ctx, ideas[2].id, "approved");
    await scheduleIdea(ctx, ideas[2].id, "2026-11-20");
  });

  async function finalRender() {
    const assetId = await uploadFile(ctx, makeFootage("pub.mp4", 8));
    await (await import("@/server/services/editing")).transcribeAsset(ctx, assetId, { jobId: "t1", signal: new AbortController().signal, progress: async () => undefined });
    const ep = await proposeEdit(ctx, { assetId, useLlm: false });
    await approveEdit(ctx, ep.editProjectId);
    const r = await requestRender(ctx, ep.editProjectId, "final");
    await drain();
    return r.id;
  }

  it("uploads only after explicit approval, resumes an interrupted upload, never uploads twice, and tracks processing", async () => {
    const dep = await enablePublishing("approval");
    void dep;
    const renderId = await finalRender();
    const job = await createPublishingJob(ctx, { renderJobId: renderId, useAi: true });
    await submitPublishing(ctx, job.id);
    expect((await getPublishing(ctx, job.id)).status).toBe("awaiting_approval");
    await drain();
    expect(yt.state.uploads).toBe(0);

    yt.state.failOnceAt = 0; // first PUT returns 503 → the job retries and resumes the same session
    const [approval] = (await listApprovals(ctx)).filter((a) => a.subjectId === job.id);
    await decideApproval(ctx, approval.id, "approved");
    for (let i = 0; i < 6 && (await getPublishing(ctx, job.id)).status !== "processing"; i++) {
      await db.update(s.jobs).set({ runAt: new Date() }).where(eq(s.jobs.status, "queued"));
      await drain({ maxJobs: 3 });
    }
    const after = await getPublishing(ctx, job.id);
    expect(after.youtubeVideoId).toBe("uploadedVid01");
    expect(yt.state.uploads).toBe(1); // one resumable session, reused after the failure
    expect((after.youtubeStatus as { notes: string[] }).notes.join(" ")).toMatch(/cannot pin comments/);

    const { runUpload } = await import("@/server/services/publishing");
    await runUpload(ctx, job.id, { signal: new AbortController().signal, progress: async () => undefined });
    expect(yt.state.uploads).toBe(1);

    yt.state.processed = true;
    await db.update(s.jobs).set({ runAt: new Date() }).where(eq(s.jobs.status, "queued"));
    await drain();
    expect((await getPublishing(ctx, job.id)).status).toBe("published");
  });

  it("rule-based mode waits for a person until the owner authorises automatic publishing", async () => {
    await enablePublishing("rule_based");
    const renderId = await finalRender();
    const job = await createPublishingJob(ctx, { renderJobId: renderId, useAi: false });
    expect((await submitPublishing(ctx, job.id)).status).toBe("awaiting_approval");

    const job2 = await createPublishingJob(ctx, { renderJobId: await finalRender(), useAi: false });
    const fresh = await (await import("@/server/tenancy")).requireWorkspace(agency.actor, ctx.workspaceId, "approve");
    await updateWorkspaceSettings(fresh, { autoPublishAuthorized: true });
    const authed = await (await import("@/server/tenancy")).requireWorkspace(agency.actor, ctx.workspaceId, "approve");
    expect((await submitPublishing(authed, job2.id)).status).toBe("approved");
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, "publishing.authorize_auto"));
    expect(audits).toHaveLength(1);
  });

  it("disconnecting revokes the token upstream and destroys the stored credential", async () => {
    const [conn] = await db.select().from(s.connections).where(and(eq(s.connections.workspaceId, ctx.workspaceId), eq(s.connections.kind, "youtube")));
    const r = await disconnect(ctx, conn.id);
    expect(r.upstreamRevoked).toBe(true);
    expect(yt.state.revoked).toContain("1//0fake-refresh");
    expect(await db.select().from(s.credentials).where(eq(s.credentials.id, conn.credentialId!))).toHaveLength(0);
  });

  async function enablePublishing(mode: "approval" | "rule_based") {
    const { startDeployment, saveClientConfiguration } = await import("@/server/services/deployments");
    const { createTemplate, publishVersion } = await import("@/server/services/blueprints");
    let [dep] = await db.select().from(s.agentDeployments).where(eq(s.agentDeployments.workspaceId, ctx.workspaceId));
    if (!dep) {
      const t = await createTemplate(agency.orgCtx, { name: "Pub", description: "" });
      const v = await publishVersion(agency.orgCtx, t.id, { bump: "major", changelog: "" });
      dep = await startDeployment(agency.orgCtx, { blueprintVersionId: v.id, workspaceId: ctx.workspaceId });
    }
    await saveClientConfiguration(ctx, { overrides: { modules: { publishing: { enabled: true, mode } } } });
    return dep;
  }
});
