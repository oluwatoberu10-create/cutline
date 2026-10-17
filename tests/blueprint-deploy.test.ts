import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeYouTube } from "./fake-youtube";
import { unzipSync, strFromU8 } from "fflate";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import * as s from "@/db/schema";
import { agentConfigSchema } from "@/lib/blueprint/schema";
import { scanForSecrets } from "@/lib/blueprint/scan";
import { addApiKeyConnection } from "@/server/services/integrations";
import { listApprovals, decideApproval } from "@/server/services/approvals";
import { confirmImport, createTemplate, exportPackage, exportPreview, getTemplate, listVersions, previewImport, publishVersion, updateTemplate } from "@/server/services/blueprints";
import {
  activateDeployment, applyVersion, availableUpdates, bindIntegration, deploymentDiff, getDeployment, listRevisions, previewVersionChange, rollback,
  saveClientConfiguration, startDeployment, testDeployment, validateDeployment,
} from "@/server/services/deployments";
import { effectiveConfig } from "@/server/services/agent-config";
import { getRun, retryRun, startRun } from "@/server/workflow/engine";
import { requireWorkspace } from "@/server/tenancy";
import { drain, makeAgency, makeClient, makeFootage, makeMember, mockProviders, uploadFile, wipe } from "./helpers";

const SECRET = "sk-ant-api03-THISISAREALLOOKINGKEYabcdefghijklmnop";

describe("blueprint: build once, export, import elsewhere, deploy to a new client", () => {
  let source: Awaited<ReturnType<typeof makeAgency>>;
  let target: Awaited<ReturnType<typeof makeAgency>>;
  let templateId: string;
  let v1: string;
  let zip: Uint8Array;

  beforeAll(async () => {
    await wipe();
    source = await makeAgency("Source");
    target = await makeAgency("Target");
    // No test talks to Google: YouTube calls go to an in-memory fake of the documented endpoints.
    vi.stubGlobal("fetch", createFakeYouTube().fetch);
  });
  afterAll(() => vi.unstubAllGlobals());

  it("builds a template, rejects secrets in it, and publishes v1.0.0", async () => {
    const t = await createTemplate(source.orgCtx, { name: "Tutorial channel agent", description: "Reusable agent for tutorial creators" });
    templateId = t.id;
    const cfg = agentConfigSchema.parse((await getTemplate(source.orgCtx, t.id)).draftConfig);
    await expect(updateTemplate(source.orgCtx, t.id, { config: { ...cfg, instructions: { ...cfg.instructions, system: `use key ${SECRET}` } } })).rejects.toThrow(/Anthropic API key/);
    await updateTemplate(source.orgCtx, t.id, { config: { ...cfg, modules: { ...cfg.modules, ideation: { ...cfg.modules.ideation, batchSize: 4 } } } });
    v1 = (await publishVersion(source.orgCtx, t.id, { bump: "minor", changelog: "Initial release" })).id;
    expect((await listVersions(source.orgCtx, t.id))[0].version).toBe("1.0.0");
    await expect(publishVersion(source.orgCtx, t.id, { bump: "patch", changelog: "" })).rejects.toThrow(/Nothing changed/);
  });

  it("exports without secrets or client data even when the source agency has clients with credentials", async () => {
    const { ctx } = await makeClient(source, "Private Client");
    await addApiKeyConnection({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, actorId: ctx.actorId }, { kind: "llm", provider: "anthropic", label: "Client key", apiKey: SECRET });
    await startDeployment(source.orgCtx, { blueprintVersionId: v1, workspaceId: ctx.workspaceId });
    await saveClientConfiguration(ctx, { profile: { niche: "Private niche of Private Client" } });

    const preview = await exportPreview(source.orgCtx, v1);
    expect(preview.blocked).toBe(false);
    expect(preview.files.map((f) => f.path)).toContain("README.md");
    const pkg = await exportPackage(source.orgCtx, v1, "zip");
    zip = pkg.body;
    const files = unzipSync(zip);
    const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("Private Client");
    expect(all).not.toContain(ctx.workspaceId);
    for (const [path, f] of Object.entries(files)) expect(scanForSecrets(strFromU8(f)), path).toEqual([]);

    const kit = unzipSync((await exportPackage(source.orgCtx, v1, "kit")).body);
    expect(Object.keys(kit)).toEqual(expect.arrayContaining(["docker-compose.yml", "DEPLOY.md", ".env.example"]));
    expect(strFromU8(kit[".env.example"])).toMatch(/^ANTHROPIC_API_KEY=$/m);
  });

  it("previews then imports into a different agency (the other installation)", async () => {
    const plan = await previewImport(target.orgCtx, zip, "agent.zip");
    expect(plan.action).toBe("create_template");
    expect(plan.report.ok).toBe(true);
    await expect(confirmImport(target.orgCtx, zip, "agent.zip", "0".repeat(64))).rejects.toThrow(/differs/);
    const r = await confirmImport(target.orgCtx, zip, "agent.zip", plan.contentHash!);
    expect(r.action).toBe("create_template");
    expect((await previewImport(target.orgCtx, zip, "agent.zip")).action).toBe("already_imported");
    // The source agency's template is untouched and invisible to the target.
    const [tpl] = await db.select().from(s.agentTemplates).where(eq(s.agentTemplates.orgId, target.org.id));
    expect(tpl.blueprintUid).toBe((await getTemplate(source.orgCtx, templateId)).blueprintUid);
  });

  let clientCtx: Awaited<ReturnType<typeof makeClient>>["ctx"];

  it("walks the deployment wizard for a new client and activates an isolated agent", async () => {
    const [ver] = await db.select().from(s.blueprintVersions).where(eq(s.blueprintVersions.orgId, target.org.id));
    ({ ctx: clientCtx } = await makeClient(target, "New YouTuber"));
    await startDeployment(target.orgCtx, { blueprintVersionId: ver.id, workspaceId: clientCtx.workspaceId });

    // Missing profile + providers → validation fails with specific reasons, activation refused.
    let v = await validateDeployment(clientCtx);
    expect(v.ok).toBe(false);
    expect(v.checks.find((c) => c.id === "profile.niche")?.status).toBe("fail");
    expect(v.checks.find((c) => c.id === "int.llm_provider")?.message).toMatch(/No language model/);
    await expect(activateDeployment(clientCtx)).rejects.toThrow(/checks failed/);

    // Overrides outside the allowed surface are refused.
    await expect(saveClientConfiguration(clientCtx, { overrides: { workflows: [] } })).rejects.toThrow(/cannot be overridden/);

    await saveClientConfiguration(clientCtx, {
      profile: { niche: "Home espresso", targetAudience: "New espresso owners", tone: "Friendly" },
      overrides: { modules: { publishing: { enabled: false }, editing: { mode: "review_first" } }, approvalGates: { ideas: false } },
    });
    await mockProviders(clientCtx);
    const [llm] = await db.select().from(s.connections).where(eq(s.connections.workspaceId, clientCtx.workspaceId));
    await bindIntegration(clientCtx, "llm_provider", llm.provider === "mock" && llm.kind === "llm" ? llm.id : (await db.select().from(s.connections).where(eq(s.connections.workspaceId, clientCtx.workspaceId))).find((c) => c.kind === "llm")!.id);

    v = await validateDeployment(clientCtx);
    expect(v.checks.find((c) => c.id === "int.youtube_connection")?.status).toBe("fail");
    // YouTube is required by this blueprint; this client has no channel yet, so it cannot activate. Mark it optional via a
    // new blueprint version would be the agency's call — here we verify the honest failure, then connect a fake channel row.
    const [cred] = await db.insert(s.credentials).values({ orgId: clientCtx.orgId, workspaceId: clientCtx.workspaceId, kind: "oauth_tokens", ciphertext: (await import("@/server/secrets")).encrypt(JSON.stringify({ access_token: "t", refresh_token: "r", expires_at: Date.now() + 3600_000, scope: "" })) }).returning();
    await db.insert(s.connections).values({ orgId: clientCtx.orgId, workspaceId: clientCtx.workspaceId, kind: "youtube", provider: "google", label: "New YouTuber channel", status: "connected", scopes: ["youtube.readonly", "yt-analytics.readonly", "youtube.upload"], credentialId: cred.id, externalAccountId: "UC_test", externalAccountName: "New YouTuber" });

    v = await validateDeployment(clientCtx);
    expect(v.checks.filter((c) => c.status === "fail")).toEqual([]);
    const tests = await testDeployment(clientCtx);
    expect(tests.find((t) => t.id === "media")?.status).toBe("pass");
    expect(tests.find((t) => t.id === "dry.footage_to_publish")?.message).toMatch(/Skipped for this client: .*Generate metadata/);
    const diff = await deploymentDiff(clientCtx);
    expect(diff.diff.map((d) => d.path)).toContain("modules.publishing.enabled");
    await activateDeployment(clientCtx);
    expect((await getDeployment(clientCtx))?.d.status).toBe("active");
  });

  it("runs the imported agent's workflow on the new client's footage, pausing for approval", async () => {
    const assetId = await uploadFile(clientCtx, makeFootage("client.mp4", 10));
    const run = await startRun(clientCtx, { workflowKey: "footage_to_publish", input: { assetId } });
    await drain();
    let state = await getRun(clientCtx, run.id);
    expect(state.run.status).toBe("waiting");
    const byNode = Object.fromEntries(state.steps.map((x) => [x.nodeId, x.status]));
    expect(byNode).toMatchObject({ transcribe: "succeeded", propose: "succeeded", draft: "succeeded", review_edit: "waiting", final: "pending" });

    // A viewer cannot approve; the owner can.
    const viewer = await makeMember(clientCtx.workspaceId, "viewer");
    const viewerCtx = await requireWorkspace(viewer.actor, clientCtx.workspaceId, "view");
    const [approval] = await listApprovals(clientCtx);
    await expect(decideApproval(viewerCtx, approval.id, "approved")).rejects.toThrow(/owner/);
    await decideApproval(clientCtx, approval.id, "approved");
    await drain();
    state = await getRun(clientCtx, run.id);
    expect(state.run.status).toBe("succeeded");
    const final = Object.fromEntries(state.steps.map((x) => [x.nodeId, x.status]));
    expect(final).toMatchObject({ final: "succeeded", metadata: "skipped", review_publish: "skipped", upload: "skipped", track: "skipped" });
    const renders = await db.select().from(s.renderJobs).where(eq(s.renderJobs.workspaceId, clientCtx.workspaceId));
    expect(renders.every((r) => r.status === "succeeded")).toBe(true);
  });

  it("fails a run honestly when a provider disappears, and retries from the failed step", async () => {
    await db.update(s.connections).set({ revokedAt: new Date(), status: "revoked" }).where(eq(s.connections.workspaceId, clientCtx.workspaceId));
    const assetId = await uploadFile(clientCtx, makeFootage("client2.mp4", 6));
    const run = await startRun(clientCtx, { workflowKey: "footage_to_publish", input: { assetId } });
    await drain();
    let state = await getRun(clientCtx, run.id);
    expect(state.run.status).toBe("failed");
    expect(state.run.error).toMatch(/speech-to-text/);
    expect(state.steps.find((x) => x.nodeId === "propose")?.status).toBe("cancelled");

    await mockProviders(clientCtx);
    await retryRun(clientCtx, run.id);
    await drain();
    state = await getRun(clientCtx, run.id);
    expect(state.run.status).toBe("waiting");
    expect(state.steps.find((x) => x.nodeId === "transcribe")?.status).toBe("succeeded");
  });

  it("does not change a deployment when the blueprint is updated, until the update is applied; rollback restores it", async () => {
    const [tpl] = await db.select().from(s.agentTemplates).where(eq(s.agentTemplates.orgId, target.org.id));
    const cfg = agentConfigSchema.parse(tpl.draftConfig);
    await updateTemplate(target.orgCtx, tpl.id, { config: { ...cfg, modules: { ...cfg.modules, editing: { ...cfg.modules.editing, rules: { ...cfg.modules.editing.rules, pauseThresholdSeconds: 2.5 } } } } });
    const v2 = await publishVersion(target.orgCtx, tpl.id, { bump: "minor", changelog: "Longer pause threshold" });
    expect(v2.version).toBe("1.1.0");

    const before = await effectiveConfig(clientCtx);
    expect(before.config.modules.editing.rules.pauseThresholdSeconds).toBe(0.9);
    expect((await availableUpdates(clientCtx)).map((u) => u.version)).toEqual(["1.1.0"]);
    const preview = await previewVersionChange(clientCtx, v2.id);
    expect(preview.diff.map((d) => d.path)).toEqual(["modules.editing.rules.pauseThresholdSeconds"]);

    await applyVersion(clientCtx, v2.id);
    const after = await effectiveConfig(clientCtx);
    expect(after.config.modules.editing.rules.pauseThresholdSeconds).toBe(2.5);
    expect(after.config.modules.publishing.enabled).toBe(false); // client overrides survive the update

    const revs = await listRevisions(clientCtx);
    const activation = revs.find((r) => r.r.reason === "Activated");
    expect(activation).toBeDefined();
    await rollback(clientCtx, activation!.r.revision);
    expect((await effectiveConfig(clientCtx)).config.modules.editing.rules.pauseThresholdSeconds).toBe(0.9);
  });
});
