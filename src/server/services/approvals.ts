import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { approvalRequests, contentIdeas } from "@/db/schema";
import { conflict, forbidden, notFound } from "@/lib/errors";
import { can, type WorkspaceCtx } from "../tenancy";
import { auditWs } from "./audit";

export type Approval = typeof approvalRequests.$inferSelect;

/** Opens an approval request (once per subject while pending). */
export async function createApproval(ws: WorkspaceCtx, a: { kind: string; title: string; subjectType: string; subjectId: string | null; payload?: Record<string, unknown>; workflowRunId?: string; stepRunId?: string }, conn: DbOrTx = db): Promise<Approval> {
  if (a.subjectId) {
    const [open] = await conn.select().from(approvalRequests).where(and(eq(approvalRequests.workspaceId, ws.workspaceId), eq(approvalRequests.subjectType, a.subjectType), eq(approvalRequests.subjectId, a.subjectId), eq(approvalRequests.status, "pending"))).limit(1);
    if (open) {
      if ((a.workflowRunId && !open.workflowRunId) || (a.stepRunId && !open.stepRunId)) {
        await conn.update(approvalRequests).set({ workflowRunId: a.workflowRunId ?? open.workflowRunId, stepRunId: a.stepRunId ?? open.stepRunId }).where(eq(approvalRequests.id, open.id));
      }
      return { ...open, workflowRunId: a.workflowRunId ?? open.workflowRunId, stepRunId: a.stepRunId ?? open.stepRunId };
    }
  }
  const [row] = await conn.insert(approvalRequests).values({
    workspaceId: ws.workspaceId, kind: a.kind, title: a.title.slice(0, 200), subjectType: a.subjectType, subjectId: a.subjectId, payload: a.payload ?? {},
    workflowRunId: a.workflowRunId ?? null, stepRunId: a.stepRunId ?? null, requestedBy: ws.actorId,
  }).returning();
  return row;
}

export async function listApprovals(ws: WorkspaceCtx, status: Approval["status"] | "all" = "pending") {
  const conds = [eq(approvalRequests.workspaceId, ws.workspaceId)];
  if (status !== "all") conds.push(eq(approvalRequests.status, status));
  return db.select().from(approvalRequests).where(and(...conds)).orderBy(desc(approvalRequests.createdAt)).limit(200);
}

export async function getApproval(ws: WorkspaceCtx, id: string) {
  const [row] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.id, id), eq(approvalRequests.workspaceId, ws.workspaceId))).limit(1);
  if (!row) throw notFound("Approval not found.");
  return row;
}

/**
 * Records a decision and applies it to the subject. Only owners (or agency
 * admins) may decide; background jobs never can. A linked workflow step is
 * resumed (approved) or failed (rejected).
 */
export async function decideApproval(ws: WorkspaceCtx, id: string, decision: "approved" | "rejected", note = "") {
  if (!ws.actorId || !can(ws.role, "approve")) throw forbidden("Only the workspace owner (or an agency admin) can approve or reject.");
  const a = await getApproval(ws, id);
  if (a.status !== "pending") throw conflict(`This request was already ${a.status}.`);

  await db.transaction(async (tx) => {
    const [updated] = await tx.update(approvalRequests).set({ status: decision, decidedBy: ws.actorId, decidedAt: new Date(), note: note.slice(0, 1000) })
      .where(and(eq(approvalRequests.id, a.id), eq(approvalRequests.status, "pending"))).returning();
    if (!updated) throw conflict("This request was decided by someone else.");

    if (a.subjectType === "edit_project" && a.subjectId) {
      const { approveEdit, requestRevision } = await import("./editing");
      if (decision === "approved") await approveEdit(ws, a.subjectId, tx);
      else await requestRevision(ws, a.subjectId, note);
    } else if (a.subjectType === "publishing_job" && a.subjectId) {
      const { markPublishingApproved } = await import("./publishing");
      const { publishingJobs } = await import("@/db/schema");
      if (decision === "approved") await markPublishingApproved(ws, a.subjectId, tx);
      else await tx.update(publishingJobs).set({ status: "draft", updatedAt: new Date() }).where(and(eq(publishingJobs.id, a.subjectId), eq(publishingJobs.workspaceId, ws.workspaceId)));
    } else if (a.subjectType === "idea_batch" && a.subjectId) {
      // Approving a batch keeps its untouched ideas (saved); rejecting archives them. Individually decided ideas are left alone.
      await tx.update(contentIdeas).set({ status: decision === "approved" ? "saved" : "archived", updatedAt: new Date() })
        .where(and(eq(contentIdeas.workspaceId, ws.workspaceId), eq(contentIdeas.batchId, a.subjectId), eq(contentIdeas.status, "proposed")));
    }
    await auditWs(ws, { action: `approval.${decision}`, entityType: a.subjectType, entityId: a.subjectId, summary: `${decision === "approved" ? "Approved" : "Rejected"}: ${a.title}`, metadata: { note } }, tx);

    if (a.stepRunId) {
      const { resumeStep } = await import("../workflow/engine");
      await resumeStep(ws, a.stepRunId, decision, note, tx);
    }
  });

  // Approving a publishing job outside a workflow queues the upload right away.
  if (decision === "approved" && a.subjectType === "publishing_job" && a.subjectId && !a.stepRunId) {
    const { enqueue } = await import("../jobs/queue");
    await enqueue({ type: "publish.upload", workspaceId: ws.workspaceId, payload: { publishingJobId: a.subjectId }, dedupeKey: `upload:${a.subjectId}`, timeoutSeconds: 7200, createdBy: ws.actorId });
  }
}

/** Resolves a pending approval for a subject when the creator acts on it directly (e.g. approves in the editor). */
export async function resolveSubjectApproval(ws: WorkspaceCtx, subjectType: string, subjectId: string, decision: "approved" | "rejected", note = ""): Promise<boolean> {
  const [open] = await db.select().from(approvalRequests).where(and(eq(approvalRequests.workspaceId, ws.workspaceId), eq(approvalRequests.subjectType, subjectType), eq(approvalRequests.subjectId, subjectId), eq(approvalRequests.status, "pending"))).limit(1);
  if (!open) return false;
  await decideApproval(ws, open.id, decision, note);
  return true;
}

export async function cancelApprovalsForRun(runId: string, conn: DbOrTx = db) {
  await conn.update(approvalRequests).set({ status: "cancelled", decidedAt: new Date() }).where(and(eq(approvalRequests.workflowRunId, runId), eq(approvalRequests.status, "pending")));
}
