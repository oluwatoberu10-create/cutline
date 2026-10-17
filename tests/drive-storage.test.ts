import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { probe } from "@/server/media/ffmpeg";
import { completeYouTubeOAuth, disconnectShared, startDriveOAuth, storageDriverIdFor, testSharedConnection } from "@/server/services/integrations";
import { getAsset, mediaUrl } from "@/server/services/media";
import { approveEdit, proposeEdit } from "@/server/services/editing";
import { requestRender } from "@/server/services/render";
import { driver, verifyMediaSignature } from "@/server/storage";
import { createFakeDrive } from "./fake-drive";
import { createFakeYouTube } from "./fake-youtube";
import { drain, makeAgency, makeClient, makeFootage, uploadFile, wipe } from "./helpers";

describe("Google Drive as media storage (fake Drive v3 endpoints, real FFmpeg)", () => {
  let agency: Awaited<ReturnType<typeof makeAgency>>;
  let drive: ReturnType<typeof createFakeDrive>;
  let yt: ReturnType<typeof createFakeYouTube>;

  beforeAll(async () => {
    await wipe();
    yt = createFakeYouTube();
    drive = createFakeDrive(yt.fetch);
    vi.stubGlobal("fetch", drive.fetch);
    agency = await makeAgency("DriveAgency");
  });
  afterAll(() => vi.unstubAllGlobals());

  const connect = async (folderLink: string, workspaceId: string | null = null) => {
    const url = new URL(await startDriveOAuth({ orgId: agency.org.id, workspaceId, actorId: agency.admin.id }, folderLink, "/agency/integrations"));
    return { url, result: await completeYouTubeOAuth(agency.admin.id, url.searchParams.get("state")!, "good-code") };
  };

  it("rejects links that are not Drive folders, and folders the user cannot edit", async () => {
    await expect(startDriveOAuth({ orgId: agency.org.id, workspaceId: null, actorId: agency.admin.id }, "https://example.com/nope", "/")).rejects.toThrow(/folder link/);
    const readOnly = drive.addFolder("Someone else's", false);
    await expect(connect(`https://drive.google.com/drive/folders/${readOnly}?usp=sharing`)).rejects.toThrow(/not add files/);
  });

  it("connects the agency Drive to an existing folder (full drive scope) and makes it the default storage", async () => {
    const folder = drive.addFolder("Agency footage");
    const { url, result } = await connect(`https://drive.google.com/drive/folders/${folder}?usp=sharing`);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive");
    expect(result.channelTitle).toBe("Google Drive · Agency footage");
    const { ctx } = await makeClient(agency, "Drive Client");
    expect(await storageDriverIdFor(ctx)).toMatch(/^gdrive:/);
    const [conn] = await db.select().from(s.connections).where(and(eq(s.connections.provider, "google_drive"), eq(s.connections.orgId, agency.org.id)));
    expect((await testSharedConnection(agency.org.id, conn.id)).ok).toBe(true);
  });

  it("without a link, requests only drive.file and creates its own folder", async () => {
    const { url, result } = await connect("");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(result.channelTitle).toBe("Google Drive · Cutline Media");
  });

  it("streams an upload straight into Drive, ingests it, and renders a real video stored in Drive", async () => {
    const { ctx } = await makeClient(agency, "Drive Footage Client");
    const assetId = await uploadFile(ctx, makeFootage("drive.mp4", 6));
    const a = await getAsset(ctx, assetId);
    expect(a.status).toBe("ready");
    expect(a.storageDriver).toMatch(/^gdrive:/);
    expect(a.sha256).toMatch(/^[a-f0-9]{64}$/); // computed at ingest, since parts never touched local disk
    expect(existsSync(`.media-test/ws/${ctx.workspaceId}`)).toBe(false);
    const names = [...drive.files.values()].map((f) => f.name).filter((n) => n.includes(assetId));
    expect(names).toEqual(expect.arrayContaining([expect.stringMatching(/original\.mp4$/), expect.stringMatching(/proxy\.mp4$/), expect.stringMatching(/speech\.mp3$/), expect.stringMatching(/thumb\.jpg$/)]));

    // Range reads (video seeking) go to Drive.
    const d = await driver(a.storageDriver);
    const chunks: Buffer[] = [];
    for await (const c of await d.readStream(a.proxyKey!, { start: 0, end: 99 })) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).byteLength).toBe(100);
    const q = new URL((await mediaUrl(ctx, a, "proxy"))!, "http://x").searchParams;
    expect(verifyMediaSignature(ctx.workspaceId, a.id, "proxy", q.get("exp")!, q.get("sig")!)).toBe(true);

    const ep = await proposeEdit(ctx, { assetId, useLlm: false });
    await approveEdit(ctx, ep.editProjectId);
    const r = await requestRender(ctx, ep.editProjectId, "final");
    await drain();
    const [row] = await db.select().from(s.renderJobs).where(eq(s.renderJobs.id, r.id));
    expect({ status: row.status, error: row.error }).toEqual({ status: "succeeded", error: null });
    const out = await getAsset(ctx, row.outputAssetId!);
    expect(out.storageDriver).toMatch(/^gdrive:/);
    const local = await (await driver(out.storageDriver)).toLocalFile(out.storageKey, `.scratch-test/drive-out-${out.id}.mp4`);
    expect((await probe(local)).width).toBe(1920);
  });

  it("disconnecting revokes access at Google and destroys the stored token", async () => {
    const conns = await db.select().from(s.connections).where(and(eq(s.connections.provider, "google_drive"), eq(s.connections.orgId, agency.org.id)));
    const c = conns.find((x) => !x.revokedAt)!;
    await disconnectShared(agency.org.id, agency.admin.id, c.id);
    expect(yt.state.revoked.length).toBeGreaterThan(0);
    expect(await db.select().from(s.credentials).where(eq(s.credentials.id, c.credentialId!))).toHaveLength(0);
  });
});
