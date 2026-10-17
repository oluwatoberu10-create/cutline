import "server-only";
import { z } from "zod";
import { db } from "@/db";
import { jobs } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { notFound } from "@/lib/errors";
import { publishMetadataSchema } from "@/lib/metadata";
import { enqueue, requestCancel, retryJob } from "../jobs/queue";
import { addPublicChannel, channelVideos, latestAnalysis, primaryChannel } from "../services/channel";
import { decideApproval, listApprovals } from "../services/approvals";
import { confirmImport, exportPackage, listAllVersions, listTemplates, previewImport } from "../services/blueprints";
import { activateDeployment, getDeployment, validateDeployment } from "../services/deployments";
import { approveEdit, decideSuggestions, edlPatch, getEdit, getTranscript, listEdits, patchEdl, suggestionsFor } from "../services/editing";
import { editIdea, ideaEdit, ideaFilters, listIdeas, setIdeaStatus } from "../services/ideas";
import { disconnect, listConnections, publicConnection, testConnection } from "../services/integrations";
import { completeUpload, createUpload, getAsset, listAssets, mediaUrl, receivePart, softDeleteAsset, uploadStatus } from "../services/media";
import { cancelPublishing, createPublishingJob, getPublishing, listPublishing, submitPublishing, updateMetadata } from "../services/publishing";
import { getRender, requestRender } from "../services/render";
import { createWorkspace, getProfile, listWorkspaces, profileInput, updateProfile, workspaceInput } from "../services/workspaces";
import { accessibleWorkspaces } from "../tenancy";
import { cancelRun, getRun, listRuns, retryRun, startRun } from "../workflow/engine";
import { route } from "./registry";

const id = z.uuid();
const W = { workspace: "view" as const }, E = { workspace: "edit" as const }, A = { workspace: "approve" as const };

/* ── identity & workspaces ────────────────────────────────────────────── */

route({ method: "GET", path: "/me", tag: "Account", summary: "The authenticated user and their organizations", access: "user",
  handler: async ({ actor }) => ({ userId: actor.userId, email: actor.email, name: actor.name, organizations: actor.orgs, via: actor.via }) });

route({ method: "GET", path: "/workspaces", tag: "Workspaces", summary: "Client workspaces the caller can access", access: "user",
  handler: async ({ actor }) => (await accessibleWorkspaces(actor)).map(({ ws, role }) => ({ id: ws.id, name: ws.name, status: ws.status, ownershipMode: ws.ownershipMode, role })) });

route({ method: "POST", path: "/workspaces", tag: "Workspaces", summary: "Create a client workspace", access: "agency", body: workspaceInput,
  handler: async ({ org }, { body }) => createWorkspace(org!, body as z.infer<typeof workspaceInput>) });

route({ method: "GET", path: "/agency/workspaces", tag: "Workspaces", summary: "All client workspaces with status counts", access: "agency", query: z.object({ q: z.string().max(80).optional(), status: z.enum(["active", "archived"]).optional() }),
  handler: async ({ org }, { query }) => (await listWorkspaces(org!.orgId, query as { q?: string })).map((r) => ({ id: r.ws.id, name: r.ws.name, status: r.ws.status, agent: r.deploymentStatus, pendingApprovals: r.pendingApprovals, failedJobs: r.failedJobs, sourceAssets: r.assets })) });

route({ method: "GET", path: "/workspaces/{ws}/profile", tag: "Workspaces", summary: "Creator profile", access: W, handler: async ({ ws }) => getProfile(ws!) });
route({ method: "PUT", path: "/workspaces/{ws}/profile", tag: "Workspaces", summary: "Update the creator profile", access: E, body: profileInput,
  handler: async ({ ws }, { body }) => { await updateProfile(ws!, body as z.infer<typeof profileInput>); return getProfile(ws!); } });

/* ── channel intelligence ─────────────────────────────────────────────── */

route({ method: "GET", path: "/workspaces/{ws}/channel", tag: "Channel", summary: "Primary channel, access report and latest analysis", access: W,
  handler: async ({ ws }) => ({ channel: await primaryChannel(ws!), analysis: await latestAnalysis(ws!) }) });
route({ method: "GET", path: "/workspaces/{ws}/channel/videos", tag: "Channel", summary: "Synced videos", access: W, handler: async ({ ws }) => channelVideos(ws!) });
route({ method: "POST", path: "/workspaces/{ws}/channel/public", tag: "Channel", summary: "Add a public channel by URL or @handle (needs YOUTUBE_API_KEY)", access: E, body: z.object({ url: z.string().min(3).max(300) }),
  handler: async ({ ws }, { body }) => addPublicChannel(ws!, (body as { url: string }).url) });
route({ method: "POST", path: "/workspaces/{ws}/channel/sync", tag: "Channel", summary: "Queue a channel sync", access: E, body: z.object({ maxVideos: z.number().int().min(1).max(500).default(200) }),
  handler: async ({ ws }, { body }) => enqueue({ type: "channel.sync", workspaceId: ws!.workspaceId, payload: { maxVideos: String((body as { maxVideos: number }).maxVideos) }, dedupeKey: `sync:${ws!.workspaceId}`, createdBy: ws!.actorId }) });
route({ method: "POST", path: "/workspaces/{ws}/channel/analyze", tag: "Channel", summary: "Queue a channel analysis", access: E, body: z.object({ useLlm: z.boolean().default(true) }),
  handler: async ({ ws }, { body }) => enqueue({ type: "channel.analyze", workspaceId: ws!.workspaceId, payload: { useLlm: String((body as { useLlm: boolean }).useLlm) }, dedupeKey: `analyze:${ws!.workspaceId}`, createdBy: ws!.actorId }) });

/* ── ideas ────────────────────────────────────────────────────────────── */

route({ method: "GET", path: "/workspaces/{ws}/ideas", tag: "Ideas", summary: "List ideas with filters", access: W, query: ideaFilters, handler: async ({ ws }, { query }) => listIdeas(ws!, query as z.infer<typeof ideaFilters>) });
route({ method: "POST", path: "/workspaces/{ws}/ideas/generate", tag: "Ideas", summary: "Queue idea generation", access: E, body: z.object({ count: z.number().int().min(1).max(30).optional(), focus: z.string().max(500).optional() }),
  handler: async ({ ws }, { body }) => { const b = body as { count?: number; focus?: string }; return enqueue({ type: "ideas.generate", workspaceId: ws!.workspaceId, payload: { ...(b.count ? { count: String(b.count) } : {}), ...(b.focus ? { focus: b.focus } : {}) }, createdBy: ws!.actorId }); } });
route({ method: "PATCH", path: "/workspaces/{ws}/ideas/{id}", tag: "Ideas", summary: "Edit an idea", access: E, body: ideaEdit,
  handler: async ({ ws, params }, { body }) => { await editIdea(ws!, id.parse(params.id), body as z.infer<typeof ideaEdit>); return { ok: true }; } });
route({ method: "POST", path: "/workspaces/{ws}/ideas/{id}/status", tag: "Ideas", summary: "Save, approve, reject or archive an idea", access: E, body: z.object({ status: z.enum(["saved", "approved", "rejected", "archived", "proposed"]), reason: z.string().max(500).default("") }),
  handler: async ({ ws, params }, { body }) => { const b = body as { status: "saved"; reason: string }; await setIdeaStatus(ws!, id.parse(params.id), b.status, b.reason); return { ok: true }; } });

/* ── media & uploads ──────────────────────────────────────────────────── */

route({ method: "POST", path: "/workspaces/{ws}/uploads", tag: "Media", summary: "Start a resumable chunked upload", access: E,
  body: z.object({ filename: z.string().min(1).max(255), size: z.number().int().positive(), role: z.enum(["source", "brand", "intro", "outro"]).default("source"), projectId: z.uuid().nullable().optional(), recordedAt: z.string().nullable().optional() }),
  handler: async ({ ws }, { body }) => { const r = await createUpload(ws!, body as Parameters<typeof createUpload>[1]); return { assetId: r.asset.id, uploadId: r.uploadId, chunkBytes: r.chunkBytes, totalParts: r.totalParts }; } });
route({ method: "PUT", path: "/workspaces/{ws}/uploads/{id}/parts/{part}", tag: "Media", summary: "Upload one part (raw bytes); re-sending a part is safe", access: E, rawBody: true,
  handler: async ({ ws, params, req }) => receivePart(ws!, id.parse(params.id), Number(params.part), req.body) });
route({ method: "GET", path: "/workspaces/{ws}/uploads/{id}", tag: "Media", summary: "Which parts have been received (to resume)", access: W, handler: async ({ ws, params }) => uploadStatus(ws!, id.parse(params.id)) });
route({ method: "POST", path: "/workspaces/{ws}/uploads/{id}/complete", tag: "Media", summary: "Assemble the upload and queue ingest", access: E, handler: async ({ ws, params }) => completeUpload(ws!, id.parse(params.id)) });
route({ method: "GET", path: "/workspaces/{ws}/media", tag: "Media", summary: "List media assets", access: W, query: z.object({ role: z.enum(["source", "brand", "intro", "outro", "render"]).optional() }),
  handler: async ({ ws }, { query }) => listAssets(ws!, query as { role?: "source" }) });
route({ method: "GET", path: "/workspaces/{ws}/media/{id}", tag: "Media", summary: "One asset with short-lived playback URLs", access: W,
  handler: async ({ ws, params }) => { const a = await getAsset(ws!, id.parse(params.id)); return { ...a, probe: undefined, urls: { proxy: await mediaUrl(ws!, a, "proxy"), original: await mediaUrl(ws!, a, "original"), thumb: await mediaUrl(ws!, a, "thumb") } }; } });
route({ method: "DELETE", path: "/workspaces/{ws}/media/{id}", tag: "Media", summary: "Delete an asset and its files", access: E, handler: async ({ ws, params }) => { await softDeleteAsset(ws!, id.parse(params.id)); return { ok: true }; } });
route({ method: "POST", path: "/workspaces/{ws}/media/{id}/transcribe", tag: "Media", summary: "Queue transcription", access: E,
  handler: async ({ ws, params }) => enqueue({ type: "media.transcribe", workspaceId: ws!.workspaceId, payload: { assetId: id.parse(params.id) }, dedupeKey: `transcribe:${params.id}`, timeoutSeconds: 3600, createdBy: ws!.actorId }) });
route({ method: "GET", path: "/workspaces/{ws}/media/{id}/transcript", tag: "Media", summary: "Transcript with timestamps", access: W,
  handler: async ({ ws, params }) => { const t = await getTranscript(ws!, id.parse(params.id)); if (!t) throw notFound("No transcript yet."); return t; } });

/* ── editing & rendering ──────────────────────────────────────────────── */

route({ method: "GET", path: "/workspaces/{ws}/edits", tag: "Editing", summary: "Edit projects", access: W, handler: async ({ ws }) => listEdits(ws!) });
route({ method: "POST", path: "/workspaces/{ws}/edits", tag: "Editing", summary: "Queue an edit proposal for a recording", access: E, body: z.object({ assetId: z.uuid(), ideaId: z.uuid().nullable().optional(), useLlm: z.boolean().default(true) }),
  handler: async ({ ws }, { body }) => { const b = body as { assetId: string; ideaId?: string | null; useLlm: boolean }; return enqueue({ type: "edit.propose", workspaceId: ws!.workspaceId, payload: { assetId: b.assetId, ideaId: b.ideaId ?? "", useLlm: String(b.useLlm) }, createdBy: ws!.actorId }); } });
route({ method: "GET", path: "/workspaces/{ws}/edits/{id}", tag: "Editing", summary: "An edit project with its EDL and suggestions", access: W,
  handler: async ({ ws, params }) => ({ edit: await getEdit(ws!, id.parse(params.id)), suggestions: await suggestionsFor(ws!, params.id) }) });
route({ method: "PATCH", path: "/workspaces/{ws}/edits/{id}", tag: "Editing", summary: "Change output, audio, captions, branding, lower thirds or clip order", access: E, body: edlPatch,
  handler: async ({ ws, params }, { body }) => ({ version: await patchEdl(ws!, id.parse(params.id), body as z.infer<typeof edlPatch>) }) });
route({ method: "POST", path: "/workspaces/{ws}/edits/{id}/suggestions", tag: "Editing", summary: "Accept, reject or reset suggested cuts", access: E, body: z.object({ decisions: z.array(z.object({ id: z.uuid(), status: z.enum(["accepted", "rejected", "proposed"]) })).min(1).max(500) }),
  handler: async ({ ws, params }, { body }) => ({ version: await decideSuggestions(ws!, id.parse(params.id), (body as { decisions: { id: string; status: "accepted" }[] }).decisions) }) });
route({ method: "POST", path: "/workspaces/{ws}/edits/{id}/approve", tag: "Editing", summary: "Approve the current version of an edit", access: A,
  handler: async ({ ws, params }) => { const { resolveSubjectApproval } = await import("../services/approvals"); if (!(await resolveSubjectApproval(ws!, "edit_project", id.parse(params.id), "approved"))) await approveEdit(ws!, params.id); return { ok: true }; } });
route({ method: "POST", path: "/workspaces/{ws}/edits/{id}/renders", tag: "Editing", summary: "Queue a draft or final render", access: E, body: z.object({ kind: z.enum(["draft", "final"]) }),
  handler: async ({ ws, params }, { body }) => requestRender(ws!, id.parse(params.id), (body as { kind: "draft" }).kind) });
route({ method: "GET", path: "/workspaces/{ws}/renders/{id}", tag: "Editing", summary: "Render status and output", access: W, handler: async ({ ws, params }) => getRender(ws!, id.parse(params.id)) });

/* ── publishing ───────────────────────────────────────────────────────── */

route({ method: "GET", path: "/workspaces/{ws}/publishing", tag: "Publishing", summary: "Publishing queue and history", access: W, handler: async ({ ws }) => (await listPublishing(ws!)).map((r) => ({ ...r.job, uploadSessionCiphertext: undefined })) });
route({ method: "POST", path: "/workspaces/{ws}/publishing", tag: "Publishing", summary: "Prepare metadata for a finished render", access: E, body: z.object({ renderJobId: z.uuid(), useAi: z.boolean().default(true) }),
  handler: async ({ ws }, { body }) => { const j = await createPublishingJob(ws!, body as { renderJobId: string; useAi: boolean }); return { ...j, uploadSessionCiphertext: undefined }; } });
route({ method: "GET", path: "/workspaces/{ws}/publishing/{id}", tag: "Publishing", summary: "One publishing job", access: W, handler: async ({ ws, params }) => ({ ...(await getPublishing(ws!, id.parse(params.id))), uploadSessionCiphertext: undefined }) });
route({ method: "PUT", path: "/workspaces/{ws}/publishing/{id}/metadata", tag: "Publishing", summary: "Replace the editable metadata", access: E, body: publishMetadataSchema,
  handler: async ({ ws, params }, { body }) => { await updateMetadata(ws!, id.parse(params.id), body); return { ok: true }; } });
route({ method: "POST", path: "/workspaces/{ws}/publishing/{id}/submit", tag: "Publishing", summary: "Send for approval (or auto-approve under authorised rules)", access: E,
  handler: async ({ ws, params }) => { const j = await submitPublishing(ws!, id.parse(params.id)); return { status: j.status }; } });
route({ method: "POST", path: "/workspaces/{ws}/publishing/{id}/cancel", tag: "Publishing", summary: "Cancel before upload", access: E, handler: async ({ ws, params }) => { await cancelPublishing(ws!, id.parse(params.id)); return { ok: true }; } });

/* ── approvals, workflows, jobs ───────────────────────────────────────── */

route({ method: "GET", path: "/workspaces/{ws}/approvals", tag: "Approvals", summary: "Approval requests", access: W, query: z.object({ status: z.enum(["pending", "approved", "rejected", "cancelled", "all"]).default("pending") }),
  handler: async ({ ws }, { query }) => listApprovals(ws!, (query as { status: "pending" }).status) });
route({ method: "POST", path: "/workspaces/{ws}/approvals/{id}/decision", tag: "Approvals", summary: "Approve or reject", access: A, body: z.object({ decision: z.enum(["approved", "rejected"]), note: z.string().max(1000).default("") }),
  handler: async ({ ws, params }, { body }) => { const b = body as { decision: "approved"; note: string }; await decideApproval(ws!, id.parse(params.id), b.decision, b.note); return { ok: true }; } });

route({ method: "GET", path: "/workspaces/{ws}/runs", tag: "Workflows", summary: "Workflow runs", access: W, handler: async ({ ws }) => (await listRuns(ws!)).map((r) => ({ ...r, definition: undefined })) });
route({ method: "POST", path: "/workspaces/{ws}/runs", tag: "Workflows", summary: "Start a workflow of the deployed agent", access: E, body: z.object({ workflowKey: z.string().max(60), input: z.record(z.string(), z.string().max(200)).default({}) }),
  handler: async ({ ws }, { body }) => { const b = body as { workflowKey: string; input: Record<string, string> }; const r = await startRun(ws!, b); return { id: r.id, status: r.status }; } });
route({ method: "GET", path: "/workspaces/{ws}/runs/{id}", tag: "Workflows", summary: "A run with step states", access: W, handler: async ({ ws, params }) => { const r = await getRun(ws!, id.parse(params.id)); return { run: { ...r.run, definition: undefined }, steps: r.steps }; } });
route({ method: "POST", path: "/workspaces/{ws}/runs/{id}/cancel", tag: "Workflows", summary: "Cancel a run", access: E, handler: async ({ ws, params }) => { await cancelRun(ws!, id.parse(params.id)); return { ok: true }; } });
route({ method: "POST", path: "/workspaces/{ws}/runs/{id}/retry", tag: "Workflows", summary: "Retry a failed run from its failed steps", access: E, handler: async ({ ws, params }) => { await retryRun(ws!, id.parse(params.id)); return { ok: true }; } });

route({ method: "GET", path: "/workspaces/{ws}/jobs/{id}", tag: "Workflows", summary: "Background job status", access: W,
  handler: async ({ ws, params }) => { const [j] = await db.select().from(jobs).where(and(eq(jobs.id, id.parse(params.id)), eq(jobs.workspaceId, ws!.workspaceId))); if (!j) throw notFound("Job not found."); return { id: j.id, type: j.type, status: j.status, progress: j.progress, note: j.progressNote, attempts: j.attempts, error: j.error, result: j.result }; } });
route({ method: "POST", path: "/workspaces/{ws}/jobs/{id}/retry", tag: "Workflows", summary: "Retry a failed job", access: E,
  handler: async ({ ws, params }) => { const [j] = await db.select().from(jobs).where(and(eq(jobs.id, id.parse(params.id)), eq(jobs.workspaceId, ws!.workspaceId))); if (!j) throw notFound("Job not found."); await retryJob(j.id); return { ok: true }; } });
route({ method: "POST", path: "/workspaces/{ws}/jobs/{id}/cancel", tag: "Workflows", summary: "Cancel a queued or running job", access: E,
  handler: async ({ ws, params }) => { const [j] = await db.select().from(jobs).where(and(eq(jobs.id, id.parse(params.id)), eq(jobs.workspaceId, ws!.workspaceId))); if (!j) throw notFound("Job not found."); await requestCancel({ jobId: j.id }); return { ok: true }; } });

/* ── integrations & deployment ────────────────────────────────────────── */

route({ method: "GET", path: "/workspaces/{ws}/integrations", tag: "Integrations", summary: "Connections (no secret material is ever returned)", access: W, handler: async ({ ws }) => (await listConnections(ws!)).map(publicConnection) });
route({ method: "POST", path: "/workspaces/{ws}/integrations/{id}/test", tag: "Integrations", summary: "Test a connection against its provider", access: A, handler: async ({ ws, params }) => testConnection(ws!, id.parse(params.id)) });
route({ method: "DELETE", path: "/workspaces/{ws}/integrations/{id}", tag: "Integrations", summary: "Revoke and remove a connection", access: A, handler: async ({ ws, params }) => disconnect(ws!, id.parse(params.id)) });
route({ method: "GET", path: "/workspaces/{ws}/deployment", tag: "Deployment", summary: "The deployed agent", access: W, handler: async ({ ws }) => getDeployment(ws!) });
route({ method: "POST", path: "/workspaces/{ws}/deployment/validate", tag: "Deployment", summary: "Run the deployment checks", access: { workspace: "agency" }, handler: async ({ ws }) => validateDeployment(ws!) });
route({ method: "POST", path: "/workspaces/{ws}/deployment/activate", tag: "Deployment", summary: "Activate the agent (fails with the failing checks)", access: { workspace: "agency" }, handler: async ({ ws }) => ({ revision: await activateDeployment(ws!) }) });

/* ── blueprints (agency) ──────────────────────────────────────────────── */

route({ method: "GET", path: "/agency/templates", tag: "Blueprints", summary: "Agent templates", access: "agency", handler: async ({ org }) => (await listTemplates(org!)).map((t) => ({ id: t.template.id, name: t.template.name, latestVersion: t.latest?.version ?? null, deployments: t.deployments })) });
route({ method: "GET", path: "/agency/blueprints", tag: "Blueprints", summary: "All blueprint versions", access: "agency", handler: async ({ org }) => (await listAllVersions(org!)).map((r) => ({ id: r.v.id, template: r.name, version: r.v.version, source: r.v.source, createdAt: r.v.createdAt })) });
route({ method: "GET", path: "/agency/blueprints/{id}/export", tag: "Blueprints", summary: "Download a blueprint (json, zip, or client-owned deployment kit)", access: "agency", query: z.object({ format: z.enum(["json", "zip", "kit"]).default("zip") }),
  handler: async ({ org, params }, { query }) => {
    const f = await exportPackage(org!, id.parse(params.id), (query as { format: "zip" }).format);
    return new Response(f.body as BodyInit, { headers: { "content-type": f.contentType, "content-disposition": `attachment; filename="${f.filename}"`, "cache-control": "no-store" } });
  } });
route({ method: "POST", path: "/agency/blueprints/import/preview", tag: "Blueprints", summary: "Validate a package and show what importing would do (writes nothing)", access: "agency", rawBody: true, query: z.object({ filename: z.string().max(200).default("blueprint.zip") }),
  handler: async ({ org, req }, { query }) => { const bytes = await readBody(req); return previewImport(org!, bytes, (query as { filename: string }).filename); } });
route({ method: "POST", path: "/agency/blueprints/import/confirm", tag: "Blueprints", summary: "Import a previewed package (contentHash must match the preview)", access: "agency", rawBody: true,
  query: z.object({ filename: z.string().max(200).default("blueprint.zip"), contentHash: z.string().regex(/^[a-f0-9]{64}$/), asNewTemplate: z.enum(["true", "false"]).default("false") }),
  handler: async ({ org, req }, { query }) => { const q = query as { filename: string; contentHash: string; asNewTemplate: string }; return confirmImport(org!, await readBody(req), q.filename, q.contentHash, { asNewTemplate: q.asNewTemplate === "true" }); } });

async function readBody(req: Request): Promise<Uint8Array> {
  const buf = new Uint8Array(await req.arrayBuffer());
  if (buf.byteLength > 5 * 1024 * 1024) throw new (await import("@/lib/errors")).AppError("VALIDATION_ERROR", "Package too large (5 MB maximum).");
  return buf;
}

