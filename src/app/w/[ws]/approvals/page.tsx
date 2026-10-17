import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Input } from "@/components/ui/field";
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Tabs, Timestamp } from "@/components/ui/kit";
import { decideAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { listApprovals } from "@/server/services/approvals";
import { can } from "@/server/tenancy";

export const metadata = { title: "Approvals" };

function subjectHref(ws: string, type: string, id: string | null, batch?: boolean) {
  if (!id) return null;
  if (type === "edit_project") return `/w/${ws}/edits/${id}`;
  if (type === "publishing_job") return `/w/${ws}/publishing/${id}`;
  if (type === "idea_batch" || batch) return `/w/${ws}/ideas?batchId=${id}&status=proposed`;
  return null;
}

export default async function Approvals({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ status?: string }> }) {
  const ws = await pageWs((await params).ws);
  const requested = (await searchParams).status;
  const status = (["pending", "approved", "rejected", "cancelled", "all"] as const).find((s) => s === requested) ?? "pending";
  const rows = await listApprovals(ws, status);
  const decide = can(ws.role, "approve");
  return (
    <>
      <PageHeader title="Approvals" description="Edits, publishing and idea batches wait here for the creator's decision. Linked workflow runs resume automatically when decided." />
      <Tabs active={status} items={["pending", "approved", "rejected", "all"].map((s) => ({ key: s, label: s[0].toUpperCase() + s.slice(1), href: `?status=${s}` }))} />
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon="checkCircle" title={status === "pending" ? "Nothing waiting" : "None"} /> : (
          <ul className="divide-y divide-[var(--border)]">{rows.map((a) => {
            const href = subjectHref(ws.workspaceId, a.subjectType, a.subjectId);
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{a.title}</span><Badge>{a.kind}</Badge><StatusBadge status={a.status} />{a.workflowRunId && <Link href={`/w/${ws.workspaceId}/runs/${a.workflowRunId}`} className="text-[12px] text-[var(--brand)]">workflow run</Link>}</div>
                  <div className="text-[12px] text-[var(--text-muted)]"><Timestamp value={a.createdAt} tz={ws.timezone} />{a.note ? ` · “${a.note}”` : ""}</div>
                </div>
                {href && <Link href={href} className="text-[13px] font-medium text-[var(--brand)]">Review</Link>}
                {decide && a.status === "pending" && (
                  <ActionForm action={decideAction} className="flex items-center gap-2">
                    <input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="id" value={a.id} />
                    <Input name="note" placeholder="Note (optional)" className="h-8 w-44 text-[12.5px]" aria-label="Note" />
                    <SubmitButton size="sm" variant="secondary" name="decision" value="rejected">Reject</SubmitButton>
                    <SubmitButton size="sm" name="decision" value="approved">Approve</SubmitButton>
                  </ActionForm>
                )}
              </li>
            );
          })}</ul>
        )}
      </Card>
      {!decide && <p className="mt-3 text-[12.5px] text-[var(--text-muted)]">Only the workspace owner or an agency admin can decide approvals.</p>}
    </>
  );
}
