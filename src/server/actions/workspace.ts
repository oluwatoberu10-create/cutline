"use server";

import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { zonedLocalToUtc } from "@/lib/dates";
import { publishMetadataSchema } from "@/lib/metadata";
import { safeInternalPath } from "@/lib/utils";
import { enqueue, requestCancel, retryJob } from "../jobs/queue";
import { addPublicChannel } from "../services/channel";
import { decideApproval, resolveSubjectApproval } from "../services/approvals";
import {
  activateDeployment, applyVersion, bindIntegration, rollback, saveClientConfiguration, setPaused, testDeployment, validateDeployment,
} from "../services/deployments";
import {
  addManualCut, adjustSuggestion, approveEdit, createShort, decideSuggestions, patchEdl, requestRevision, restoreRevision,
} from "../services/editing";
import { editIdea, regenerateIdea, scheduleIdea, setIdeaStatus, unscheduleIdea } from "../services/ideas";
import { addApiKeyConnection, addS3Connection, disconnect, startYouTubeOAuth, testConnection } from "../services/integrations";
import { createProject, softDeleteAsset } from "../services/media";
import { cancelPublishing, createPublishingJob, submitPublishing, updateMetadata } from "../services/publishing";
import { cancelRender, requestRender } from "../services/render";
import { createInvite, scheduleWorkspaceDeletion, setMemberRole, updateProfile, updateWorkspace, updateWorkspaceSettings } from "../services/workspaces";
import { cancelRun, retryRun, startRun } from "../workflow/engine";
import { act, bool, list, num, str, wsCtx } from "./util";

/* ── profile & channel ────────────────────────────────────────────────── */

export async function saveProfileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    await updateProfile(ws, {
      niche: str(fd, "niche"), targetAudience: str(fd, "targetAudience"), audienceProblems: list(fd, "audienceProblems"), audienceInterests: list(fd, "audienceInterests"),
      formats: list(fd, "formats"), preferredLengthMin: num(fd, "preferredLengthMin"), preferredLengthMax: num(fd, "preferredLengthMax"), tone: str(fd, "tone"),
      goals: str(fd, "goals"), avoidTopics: list(fd, "avoidTopics"), competitorChannels: list(fd, "competitorChannels"), contentCategories: list(fd, "contentCategories"),
      publishingFrequency: str(fd, "publishingFrequency"), brandVoice: str(fd, "brandVoice"), savedPreferences: list(fd, "savedPreferences"),
    });
    return "Profile saved. The agent uses it for analysis, ideas and metadata.";
  });
}

export async function connectYouTubeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let url = "";
  const r = await act(async () => {
    const ws = await wsCtx(fd, "approve");
    const scopes = ["youtube.readonly", ...(bool(fd, "analytics") ? ["yt-analytics.readonly"] : []), ...(bool(fd, "upload") ? ["youtube.upload"] : []), ...(bool(fd, "manage") ? ["youtube.force-ssl"] : [])];
    url = await startYouTubeOAuth(ws, scopes, safeInternalPath(str(fd, "returnTo"), `/w/${ws.workspaceId}/integrations`));
  });
  if (r.ok) redirect(url);
  return r;
}

export async function addPublicChannelAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const c = await addPublicChannel(await wsCtx(fd, "edit"), str(fd, "url")); return `Added "${c.title}". Run a sync to import its public videos.`; });
}

export async function queueJobAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const type = str(fd, "type");
    const allowed: Record<string, { label: string; dedupe?: string; payload: Record<string, string>; timeout?: number }> = {
      "channel.sync": { label: "Channel sync", dedupe: `sync:${ws.workspaceId}`, payload: { maxVideos: str(fd, "maxVideos") || "200" } },
      "channel.analyze": { label: "Channel analysis", dedupe: `analyze:${ws.workspaceId}`, payload: { useLlm: String(fd.get("useLlm") !== "false") } },
      "ideas.generate": { label: "Idea generation", payload: { ...(str(fd, "count") ? { count: str(fd, "count") } : {}), ...(str(fd, "focus") ? { focus: str(fd, "focus").slice(0, 500) } : {}) } },
      "media.transcribe": { label: "Transcription", dedupe: `transcribe:${str(fd, "assetId")}`, payload: { assetId: str(fd, "assetId") }, timeout: 3600 },
      "edit.propose": { label: "Edit proposal", payload: { assetId: str(fd, "assetId"), ideaId: str(fd, "ideaId"), useLlm: String(fd.get("useLlm") !== "false") } },
    };
    const spec = allowed[type];
    if (!spec) return { ok: false, error: "Unknown action." };
    await enqueue({ type, workspaceId: ws.workspaceId, payload: spec.payload, dedupeKey: spec.dedupe ?? null, timeoutSeconds: spec.timeout ?? 900, createdBy: ws.actorId });
    return `${spec.label} queued. Progress appears in Workflow runs.`;
  });
}

/* ── ideas & calendar ─────────────────────────────────────────────────── */

export async function ideaStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const status = str(fd, "status");
    if (status === "regenerate") { await regenerateIdea(ws, str(fd, "id"), str(fd, "reason")); return "Rejected and a replacement idea generated."; }
    await setIdeaStatus(ws, str(fd, "id"), status as "approved", str(fd, "reason"));
    return `Idea ${status}.`;
  });
}

export async function editIdeaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    await editIdea(ws, str(fd, "id"), { title: str(fd, "title"), concept: str(fd, "concept"), hook: str(fd, "hook"), topic: str(fd, "topic"), targetAudience: str(fd, "targetAudience"), format: str(fd, "format"), lengthMinutes: num(fd, "lengthMinutes"), outline: list(fd, "outline"), keywords: list(fd, "keywords"), priorityScore: num(fd, "priorityScore") ?? undefined });
    return "Idea updated.";
  });
}

export async function scheduleIdeaAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    if (!str(fd, "date")) { await unscheduleIdea(ws, str(fd, "id")); return "Removed from the calendar."; }
    await scheduleIdea(ws, str(fd, "id"), str(fd, "date"), str(fd, "notes"));
    return "Scheduled.";
  });
}

/* ── media & editing ──────────────────────────────────────────────────── */

export async function createProjectAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await createProject(await wsCtx(fd, "edit"), { title: str(fd, "title"), ideaId: str(fd, "ideaId") || null, recordingDate: str(fd, "recordingDate") || null }); return "Project created."; });
}

export async function deleteAssetAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await softDeleteAsset(await wsCtx(fd, "edit"), str(fd, "id")); return "Deleted. Stored files are being removed."; });
}

export async function suggestionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const ids = fd.getAll("id").map(String);
    await decideSuggestions(ws, str(fd, "edit"), ids.map((id) => ({ id, status: str(fd, "status") as "accepted" })));
    return str(fd, "status") === "rejected" ? "Restored to the cut." : str(fd, "status") === "accepted" ? "Applied to the cut." : "Reset.";
  });
}

export async function adjustCutAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await adjustSuggestion(await wsCtx(fd, "edit"), str(fd, "edit"), str(fd, "id"), Number(str(fd, "start")), Number(str(fd, "end"))); return "Timestamps updated."; });
}

export async function manualCutAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await addManualCut(await wsCtx(fd, "edit"), str(fd, "edit"), { assetId: str(fd, "assetId"), start: Number(str(fd, "start")), end: Number(str(fd, "end")), note: str(fd, "note") }); return "Segment removed from the cut."; });
}

export async function edlSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const lowerThirds = str(fd, "lowerThirds").split("\n").map((l) => l.trim()).filter(Boolean).map((l, i) => {
      const [at, dur, text, sub] = l.split("|").map((x) => x.trim());
      return { id: `l${i + 1}`, start: Number(at), duration: Number(dur) || 4, text: text ?? "", subtext: sub ?? "" };
    });
    await patchEdl(ws, str(fd, "edit"), {
      output: { presetId: str(fd, "presetId"), reframe: str(fd, "reframe") as "fit" },
      audio: { normalize: bool(fd, "normalize"), noiseReduction: str(fd, "noiseReduction") as "off", targetLufs: Number(str(fd, "targetLufs") || -14) },
      transitions: { type: str(fd, "transition") as "none", durationMs: Number(str(fd, "transitionMs") || 200) },
      captions: { enabled: bool(fd, "captions"), burnIn: bool(fd, "burnIn") },
      branding: { logoAssetId: str(fd, "logoAssetId") || null, introAssetId: str(fd, "introAssetId") || null, outroAssetId: str(fd, "outroAssetId") || null, logoPosition: (str(fd, "logoPosition") || "top-right") as "top-right" },
      lowerThirds,
    });
    return "Edit settings saved.";
  });
}

export async function captionEditAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const edits = fd.getAll("cueId").map((id, i) => ({ id: String(id), text: String(fd.getAll("cueText")[i] ?? "") }));
    await patchEdl(ws, str(fd, "edit"), { cueEdits: edits });
    return "Captions updated.";
  });
}

export async function clipOrderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await patchEdl(await wsCtx(fd, "edit"), str(fd, "edit"), { clipOrder: str(fd, "order").split(",") }); return "Clip order saved."; });
}

export async function addSourceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await patchEdl(await wsCtx(fd, "edit"), str(fd, "edit"), { addSource: { assetId: str(fd, "assetId") } }); return "Recording appended to the sequence."; });
}

export async function restoreRevisionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await restoreRevision(await wsCtx(fd, "edit"), str(fd, "edit"), Number(str(fd, "version"))); return "Earlier version restored as a new version."; });
}

export async function approveEditAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "approve");
    if (!(await resolveSubjectApproval(ws, "edit_project", str(fd, "edit"), "approved"))) await approveEdit(ws, str(fd, "edit"));
    return "Approved. You can now render the final video.";
  });
}

export async function requestRevisionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    if (!(await resolveSubjectApproval(ws, "edit_project", str(fd, "edit"), "rejected", str(fd, "note")).catch(() => false))) await requestRevision(ws, str(fd, "edit"), str(fd, "note"));
    return "Marked as needing revisions.";
  });
}

export async function renderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = await requestRender(await wsCtx(fd, "edit"), str(fd, "edit"), str(fd, "kind") as "draft"); return r.status === "succeeded" ? "This version is already rendered." : "Render queued."; });
}

export async function cancelRenderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await cancelRender(await wsCtx(fd, "edit"), str(fd, "id")); return "Cancellation requested."; });
}

export async function createShortAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let target = "";
  const r = await act(async () => { const ws = await wsCtx(fd, "edit"); const s = await createShort(ws, str(fd, "edit"), str(fd, "suggestion")); target = `/w/${ws.workspaceId}/edits/${s.id}`; });
  if (r.ok) redirect(target);
  return r;
}

/* ── publishing ───────────────────────────────────────────────────────── */

export async function createPublishingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let target = "";
  const r = await act(async () => {
    const ws = await wsCtx(fd, "edit");
    const j = await createPublishingJob(ws, { renderJobId: str(fd, "renderJobId"), useAi: fd.get("useAi") !== "false" });
    target = `/w/${ws.workspaceId}/publishing/${j.id}`;
  });
  if (r.ok) redirect(target);
  return r;
}

export async function saveMetadataAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const publishAt = str(fd, "publishAt");
    const metadata = publishMetadataSchema.parse({
      title: str(fd, "title"), description: String(fd.get("description") ?? ""), tags: list(fd, "tags"), hashtags: list(fd, "hashtags").map((h) => (h.startsWith("#") ? h : `#${h}`)),
      chapters: str(fd, "chapters").split("\n").map((l) => /^(\d+):(\d{2})(?::(\d{2}))?\s+(.+)$/.exec(l.trim())).filter(Boolean).map((m) => ({ start: m![3] ? Number(m![1]) * 3600 + Number(m![2]) * 60 + Number(m![3]) : Number(m![1]) * 60 + Number(m![2]), title: m![4] })),
      categoryId: str(fd, "categoryId") || "22", privacyStatus: str(fd, "privacyStatus") || "private",
      publishAt: publishAt ? zonedLocalToUtc(publishAt, ws.timezone).toISOString() : null, madeForKids: bool(fd, "madeForKids"),
      playlistId: str(fd, "playlistId") || null, pinnedComment: String(fd.get("pinnedComment") ?? ""), language: str(fd, "language") || "en",
    });
    await updateMetadata(ws, str(fd, "id"), metadata);
    return "Metadata saved.";
  });
}

export async function submitPublishingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const j = await submitPublishing(await wsCtx(fd, "edit"), str(fd, "id")); return j.status === "approved" ? "Approved under the workspace's publishing rules; upload queued." : "Sent for approval."; });
}

export async function cancelPublishingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await cancelPublishing(await wsCtx(fd, "edit"), str(fd, "id")); return "Cancelled."; });
}

/* ── approvals, runs, jobs ────────────────────────────────────────────── */

export async function decideAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await decideApproval(await wsCtx(fd, "approve"), str(fd, "id"), str(fd, "decision") as "approved", str(fd, "note")); return str(fd, "decision") === "approved" ? "Approved." : "Rejected."; });
}

export async function startRunAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let target = "";
  const r = await act(async () => {
    const ws = await wsCtx(fd, "edit");
    const input: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith("in_")) input[k.slice(3)] = String(v);
    const run = await startRun(ws, { workflowKey: str(fd, "workflowKey"), input });
    target = `/w/${ws.workspaceId}/runs/${run.id}`;
  });
  if (r.ok) redirect(target);
  return r;
}

export async function runControlAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    if (str(fd, "op") === "cancel") { await cancelRun(ws, str(fd, "id")); return "Run cancelled."; }
    await retryRun(ws, str(fd, "id"));
    return "Retrying from the failed step.";
  });
}

export async function jobControlAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "edit");
    const { db } = await import("@/db");
    const { jobs } = await import("@/db/schema");
    const { and, eq } = await import("drizzle-orm");
    const [j] = await db.select().from(jobs).where(and(eq(jobs.id, str(fd, "id")), eq(jobs.workspaceId, ws.workspaceId)));
    if (!j) return { ok: false, error: "Job not found." };
    if (str(fd, "op") === "cancel") { await requestCancel({ jobId: j.id }); return "Cancellation requested."; }
    await retryJob(j.id);
    return "Job re-queued.";
  });
}

/* ── integrations ─────────────────────────────────────────────────────── */

export async function addProviderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "approve");
    await addApiKeyConnection({ orgId: ws.orgId, workspaceId: ws.workspaceId, actorId: ws.actorId }, { kind: str(fd, "kind") as "llm", provider: str(fd, "provider"), label: str(fd, "label"), apiKey: str(fd, "apiKey"), model: str(fd, "model") || undefined });
    return "Saved (the key is encrypted and never shown again). Use Test to verify it.";
  });
}

export async function addS3Action(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    await addS3Connection(await wsCtx(fd, "approve"), { label: str(fd, "label"), bucket: str(fd, "bucket"), region: str(fd, "region"), endpoint: str(fd, "endpoint") || null, forcePathStyle: bool(fd, "forcePathStyle"), accessKeyId: str(fd, "accessKeyId"), secretAccessKey: str(fd, "secretAccessKey") });
    return "Bucket connected. Test it, then bind it as media_storage on the Agent page.";
  });
}

export async function testProviderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = await testConnection(await wsCtx(fd, "approve"), str(fd, "id")); return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message }; });
}

export async function disconnectAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = await disconnect(await wsCtx(fd, "approve"), str(fd, "id")); return r.upstreamRevoked ? "Disconnected and access revoked at Google." : "Disconnected; the stored credential was destroyed."; });
}

/* ── deployment (agency) ──────────────────────────────────────────────── */

export async function deploymentConfigAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const r = await act(async () => {
    const ws = await wsCtx(fd, "agency");
    const overrides: Record<string, unknown> = {
      modules: {
        ideation: { enabled: bool(fd, "ideation"), batchSize: Number(str(fd, "batchSize") || 10), refresh: str(fd, "refresh") || "manual" },
        editing: { enabled: bool(fd, "editing"), mode: str(fd, "editingMode") || "review_first", captions: { enabled: bool(fd, "captions"), burnIn: bool(fd, "burnIn") }, rules: { pauseThresholdSeconds: Number(str(fd, "pauseThreshold") || 0.9), removeFillerWords: bool(fd, "removeFillers") }, audio: { noiseReduction: str(fd, "noiseReduction") || "off" } },
        publishing: { enabled: bool(fd, "publishing"), mode: str(fd, "publishMode") || "approval", defaultPrivacy: str(fd, "defaultPrivacy") || "private" },
      },
    };
    await saveClientConfiguration(ws, { overrides, step: 6 });
  });
  // Save & continue: move to validation only once the configuration is stored.
  if (r.ok) redirect(`/agency/deploy?ws=${str(fd, "ws")}&step=6&saved=1`);
  return r;
}

const PROFILE_LABELS: Record<string, string> = { niche: "Channel niche", targetAudience: "Target audience", tone: "Tone and personality", goals: "Content goals", brandVoice: "Brand voice", publishingFrequency: "Publishing frequency", audienceProblems: "Audience problems", formats: "Preferred formats" };

export async function deploymentProfileAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const r = await act(async () => {
    const ws = await wsCtx(fd, "agency");
    const profile = { niche: str(fd, "niche"), targetAudience: str(fd, "targetAudience"), audienceProblems: list(fd, "audienceProblems"), formats: list(fd, "formats"), tone: str(fd, "tone"), goals: str(fd, "goals"), brandVoice: str(fd, "brandVoice"), publishingFrequency: str(fd, "publishingFrequency"), avoidTopics: list(fd, "avoidTopics") };
    // Fields the blueprint requires must be filled before moving on (validation re-checks them server-side).
    const fieldErrors: Record<string, string> = {};
    for (const key of str(fd, "required").split(",").filter(Boolean)) {
      const v = profile[key as keyof typeof profile];
      if (Array.isArray(v) ? v.length === 0 : !v) fieldErrors[key] = `${PROFILE_LABELS[key] ?? key} is required by this blueprint.`;
    }
    if (Object.keys(fieldErrors).length) return { ok: false, error: "Fill in the required fields to continue.", fieldErrors };
    await saveClientConfiguration(ws, { profile, step: 4 });
  });
  if (r.ok) redirect(`/agency/deploy?ws=${str(fd, "ws")}&step=4&saved=1`);
  return r;
}

export async function bindAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await bindIntegration(await wsCtx(fd, "agency"), str(fd, "ref"), str(fd, "connectionId") || null); return "Binding saved."; });
}

export async function validateDeploymentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const v = await validateDeployment(await wsCtx(fd, "agency")); return v.ok ? "All required checks passed." : { ok: false, error: `${v.checks.filter((c) => c.status === "fail").length} check(s) failed — see below.` }; });
}

export async function testDeploymentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = await testDeployment(await wsCtx(fd, "agency")); const f = r.filter((x) => x.status === "fail").length; return f ? { ok: false, error: `${f} test(s) failed — see below.` } : "All tests passed."; });
}

export async function activateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const rev = await activateDeployment(await wsCtx(fd, "agency")); return `Agent activated (revision ${rev}).`; });
}

export async function pauseAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { await setPaused(await wsCtx(fd, "agency"), fd.get("pause") === "true"); return fd.get("pause") === "true" ? "Agent paused." : "Agent resumed."; });
}

export async function applyVersionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = await applyVersion(await wsCtx(fd, "agency"), str(fd, "versionId")); return `Applied (revision ${r}).`; });
}

export async function rollbackAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = await rollback(await wsCtx(fd, "agency"), Number(str(fd, "revision"))); return `Rolled back (now revision ${r}).`; });
}

/* ── workspace settings & members ─────────────────────────────────────── */

export async function workspaceSettingsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "approve");
    await updateWorkspace(ws, { name: str(fd, "name") || undefined, contactEmail: str(fd, "contactEmail"), timezone: str(fd, "timezone") || undefined });
    const agencyOnly = ws.role === "agency_admin";
    await updateWorkspaceSettings(ws, {
      allowAgencyProviders: agencyOnly ? bool(fd, "allowAgencyProviders") : ws.settings.allowAgencyProviders,
      limits: agencyOnly ? { maxUploadMb: Number(str(fd, "maxUploadMb")), monthlyRenderMinutes: Number(str(fd, "monthlyRenderMinutes")), monthlyTranscriptionMinutes: Number(str(fd, "monthlyTranscriptionMinutes")), monthlyLlmCalls: Number(str(fd, "monthlyLlmCalls")) } : ws.settings.limits,
      retention: { renderDays: Number(str(fd, "renderDays")), sourceDays: Number(str(fd, "sourceDays")) },
    });
    return "Settings saved.";
  });
}

export async function autoPublishAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "approve");
    await updateWorkspaceSettings(ws, { autoPublishAuthorized: fd.get("authorize") === "true" });
    return fd.get("authorize") === "true" ? "Rule-based publishing authorised. You can revoke this at any time." : "Authorisation revoked; every upload now needs approval.";
  });
}

export async function inviteMemberAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => {
    const ws = await wsCtx(fd, "approve");
    const r = await createInvite({ orgId: ws.orgId, workspaceId: ws.workspaceId, actorId: ws.actorId! }, { email: str(fd, "email"), workspaceRole: (str(fd, "role") || "editor") as "editor" });
    return { message: "Invite created. Share the link (expires in 7 days).", data: { link: r.path } };
  });
}

export async function memberRoleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return act(async () => { const r = str(fd, "role"); await setMemberRole(await wsCtx(fd, "approve"), str(fd, "userId"), r === "remove" ? null : (r as "editor")); return "Member updated."; });
}

export async function deleteWorkspaceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const r = await act(async () => { await scheduleWorkspaceDeletion(await wsCtx(fd, "agency"), str(fd, "confirm")); });
  if (r.ok) redirect("/agency/clients?deleted=1");
  return r;
}
