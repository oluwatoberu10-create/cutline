import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import type { Edl } from "@/lib/edl";
import { AppError } from "@/lib/errors";
import { probe } from "@/server/media/ffmpeg";
import { enqueue } from "@/server/jobs/queue";
import { addManualCut, approveEdit, createShort, decideSuggestions, getEdit, getTranscript, patchEdl, proposeEdit, suggestionsFor } from "@/server/services/editing";
import { getAsset, mediaUrl } from "@/server/services/media";
import { createPublishingJob, runUpload, updateMetadata } from "@/server/services/publishing";
import { executeRender, requestRender } from "@/server/services/render";
import { driver, verifyMediaSignature } from "@/server/storage";
import { drain, makeAgency, makeClient, makeFootage, makeLogo, mockProviders, uploadFile, wipe } from "./helpers";

describe("raw-footage pipeline (real FFmpeg, mock AI providers)", () => {
  let ctx: Awaited<ReturnType<typeof makeClient>>["ctx"];
  let assetId: string;

  beforeAll(async () => {
    await wipe();
    const agency = await makeAgency();
    ({ ctx } = await makeClient(agency, "Creator One"));
    await mockProviders(ctx);
    assetId = await uploadFile(ctx, makeFootage());
  });

  it("ingests real footage: probe, working copies and measured silences; original preserved", async () => {
    const a = await getAsset(ctx, assetId);
    expect(a.status).toBe("ready");
    expect(a.durationSeconds).toBeCloseTo(12, 0);
    expect(a.width).toBe(640);
    expect(a.proxyKey && a.audioKey && a.thumbnailKey).toBeTruthy();
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/);
    const silences = a.silences as { start: number; end: number }[];
    expect(silences.some((x) => Math.abs(x.start - 3) < 0.3 && Math.abs(x.end - 5) < 0.3)).toBe(true);
    const d = await driver(a.storageDriver);
    expect(await d.size(a.storageKey)).toBe(a.sizeBytes);
    const url = await mediaUrl(ctx, a, "proxy");
    const q = new URL(url!, "http://x").searchParams;
    expect(verifyMediaSignature(ctx.workspaceId, a.id, "proxy", q.get("exp")!, q.get("sig")!)).toBe(true);
  });

  it("rejects a file that is not real media and removes it from storage", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(".scratch-test/fixtures/fake.mp4", "#!/bin/sh\necho not a video\n".repeat(50));
    const id = await uploadFile(ctx, ".scratch-test/fixtures/fake.mp4");
    const a = await getAsset(ctx, id);
    expect(a.status).toBe("failed");
    expect(a.error).toMatch(/Rejected/);
    await expect((await driver(a.storageDriver)).size(a.storageKey)).rejects.toThrow();
  });

  it("transcribes through the queue (mock provider, flagged as mock)", async () => {
    await enqueue({ type: "media.transcribe", workspaceId: ctx.workspaceId, payload: { assetId } });
    await drain();
    const t = await getTranscript(ctx, assetId);
    expect(t?.isMock).toBe(true);
    expect((t!.segments as unknown[]).length).toBeGreaterThan(1);
  });

  it("proposes a review-first cut from measured pauses, fillers and repeats, dropping invented AI references", async () => {
    const r = await proposeEdit(ctx, { assetId, useLlm: true });
    const sugg = await suggestionsFor(ctx, r.editProjectId);
    const types = new Set(sugg.map((x) => x.type));
    expect(types.has("pause")).toBe(true);
    expect(types.has("filler")).toBe(true);
    expect(types.has("repeat")).toBe(true);
    expect(sugg.filter((x) => x.origin === "ai").length).toBe(2); // the invented segment id was dropped
    const ep = await getEdit(ctx, r.editProjectId);
    expect(ep.status).toBe("in_review");
    const edl = ep.edl as Edl;
    const total = edl.clips.reduce((t, c) => t + c.out - c.in, 0);
    expect(total).toBeLessThan(12);
    expect(sugg.filter((x) => x.origin === "measured").every((x) => x.status === "accepted")).toBe(true);
  });

  it("restores and adds cuts non-destructively, and blocks final render until approved", async () => {
    const [ep] = await db.select().from(s.editProjects).where(eq(s.editProjects.workspaceId, ctx.workspaceId));
    const sugg = await suggestionsFor(ctx, ep.id);
    const pause = sugg.find((x) => x.type === "pause")!;
    const before = ((await getEdit(ctx, ep.id)).edl as Edl).clips.reduce((t, c) => t + c.out - c.in, 0);
    await decideSuggestions(ctx, ep.id, [{ id: pause.id, status: "rejected" }]);
    const restored = ((await getEdit(ctx, ep.id)).edl as Edl).clips.reduce((t, c) => t + c.out - c.in, 0);
    expect(restored).toBeGreaterThan(before);
    await addManualCut(ctx, ep.id, { assetId, start: 10.5, end: 11.5 });
    await expect(requestRender(ctx, ep.id, "final")).rejects.toThrow(/Approve the current version/);
  });

  it("renders a real draft and a real final with burned captions, a logo and loudness normalisation", async () => {
    const logo = await uploadFile(ctx, makeLogo(), "brand");
    const [ep] = await db.select().from(s.editProjects).where(eq(s.editProjects.workspaceId, ctx.workspaceId));
    await patchEdl(ctx, ep.id, { captions: { burnIn: true }, branding: { logoAssetId: logo }, transitions: { type: "fade" }, lowerThirds: [{ id: "l1", text: "Creator One", subtext: "Host", start: 0.5, duration: 2 }] });

    const draft = await requestRender(ctx, ep.id, "draft");
    await drain();
    const [d] = await db.select().from(s.renderJobs).where(eq(s.renderJobs.id, draft.id));
    expect(d.status).toBe("succeeded");
    const out = await getAsset(ctx, d.outputAssetId!);
    const local = await (await driver(out.storageDriver)).toLocalFile(out.storageKey, "");
    const p = await probe(local);
    expect(p.width).toBe(960);
    expect(p.hasAudio && p.hasVideo).toBe(true);
    const edl = (await getEdit(ctx, ep.id)).edl as Edl;
    expect(p.duration).toBeCloseTo(edl.clips.reduce((t, c) => t + c.out - c.in, 0), 0);

    // Asking again for the same version returns the same render instead of duplicating work.
    expect((await requestRender(ctx, ep.id, "draft")).id).toBe(draft.id);

    await approveEdit(ctx, ep.id);
    const fin = await requestRender(ctx, ep.id, "final");
    await drain();
    const [f] = await db.select().from(s.renderJobs).where(eq(s.renderJobs.id, fin.id));
    expect(f.status).toBe("succeeded");
    expect((await getEdit(ctx, ep.id)).status).toBe("rendered");
    const fo = await getAsset(ctx, f.outputAssetId!);
    expect(fo.width).toBe(1920);
    expect(f.captionsKey).toBeTruthy();
  });

  it("re-running a finished render is a no-op (idempotent)", async () => {
    const [f] = await db.select().from(s.renderJobs).where(and(eq(s.renderJobs.workspaceId, ctx.workspaceId), eq(s.renderJobs.kind, "final")));
    const again = await executeRender(ctx, f.id, { jobId: "x", signal: new AbortController().signal, progress: async () => undefined });
    expect(again.reused).toBe(true);
    const renders = await db.select().from(s.mediaAssets).where(and(eq(s.mediaAssets.workspaceId, ctx.workspaceId), eq(s.mediaAssets.role, "render")));
    expect(renders).toHaveLength(2);
  });

  it("creates a vertical short and renders it at 1080x1920", async () => {
    const [ep] = await db.select().from(s.editProjects).where(eq(s.editProjects.workspaceId, ctx.workspaceId));
    const shortSugg = (await suggestionsFor(ctx, ep.id)).find((x) => x.type === "short_clip")!;
    const short = await createShort(ctx, ep.id, shortSugg.id);
    await approveEdit(ctx, short.id);
    const r = await requestRender(ctx, short.id, "final");
    await drain();
    const [row] = await db.select().from(s.renderJobs).where(eq(s.renderJobs.id, r.id));
    expect(row.status).toBe("succeeded");
    const a = await getAsset(ctx, row.outputAssetId!);
    expect([a.width, a.height]).toEqual([1080, 1920]);
  });

  it("drafts grounded, editable metadata and enforces YouTube rules", async () => {
    const [f] = await db.select().from(s.renderJobs).where(and(eq(s.renderJobs.workspaceId, ctx.workspaceId), eq(s.renderJobs.kind, "final")));
    const job = await createPublishingJob(ctx, { renderJobId: f.id, useAi: true });
    expect(job.isMock).toBe(true);
    const m = job.metadata as { title: string; hashtags: string[]; tags: string[] };
    expect(m.title).toContain("[mock]");
    expect(m.hashtags).not.toContain("not a hashtag");
    const sugg = job.suggestions as { playlistSuggestions: { playlistId: string }[] };
    expect(sugg.playlistSuggestions.find((p) => p.playlistId === "PL_INVENTED")).toBeUndefined();
    // Same render → same publishing job.
    expect((await createPublishingJob(ctx, { renderJobId: f.id, useAi: true })).id).toBe(job.id);
    await expect(updateMetadata(ctx, job.id, { ...m, title: "<script>", description: "" })).rejects.toThrow();
    await expect(updateMetadata(ctx, job.id, { ...m, description: "", privacyStatus: "public", publishAt: new Date(Date.now() + 864e5).toISOString() })).rejects.toThrow(/private/);
  });

  it("refuses to upload anything that was not approved", async () => {
    const [job] = await db.select().from(s.publishingJobs).where(eq(s.publishingJobs.workspaceId, ctx.workspaceId));
    await expect(runUpload(ctx, job.id, { signal: new AbortController().signal, progress: async () => undefined })).rejects.toThrow(/not been approved/);
  });

  it("reports a missing integration instead of pretending", async () => {
    const agency = await makeAgency("Second");
    const { ctx: bare } = await makeClient(agency, "No Providers");
    const id = await uploadFile(bare, makeFootage("b.mp4", 4));
    await expect((async () => {
      const { transcribeAsset } = await import("@/server/services/editing");
      await transcribeAsset(bare, id, { jobId: "t", signal: new AbortController().signal, progress: async () => undefined });
    })()).rejects.toSatisfy((e: unknown) => e instanceof AppError && e.code === "NOT_CONFIGURED" && /speech-to-text/.test(e.message));
  });
});
