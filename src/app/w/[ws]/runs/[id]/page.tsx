import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { runLogs } from "@/db/schema";
import { AutoRefresh } from "@/components/forms";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Badge, Card, CardHeader, KeyValue, Notice, PageHeader, StatusBadge, Timestamp } from "@/components/ui/kit";
import type { WorkflowDefinition } from "@/lib/workflow/definition";
import { nodeSpec } from "@/lib/workflow/nodes";
import { runControlAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { can } from "@/server/tenancy";
import { getRun } from "@/server/workflow/engine";

export const metadata = { title: "Run" };

const outputLink = (ws: string, out: Record<string, unknown> | null) => {
  if (!out) return null;
  if (typeof out.editProjectId === "string") return <Link className="text-[var(--brand)]" href={`/w/${ws}/edits/${out.editProjectId}`}>Open edit</Link>;
  if (typeof out.publishingJobId === "string") return <Link className="text-[var(--brand)]" href={`/w/${ws}/publishing/${out.publishingJobId}`}>Open publishing job</Link>;
  if (typeof out.batchId === "string") return <Link className="text-[var(--brand)]" href={`/w/${ws}/ideas?batchId=${out.batchId}`}>Open ideas</Link>;
  if (typeof out.approvalId === "string") return <Link className="text-[var(--brand)]" href={`/w/${ws}/approvals`}>Open approval</Link>;
  if (typeof out.analysisId === "string") return <Link className="text-[var(--brand)]" href={`/w/${ws}/channel`}>Open insights</Link>;
  return null;
};

export default async function RunPage({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: wsId, id } = await params;
  const ws = await pageWs(wsId);
  const { run, steps } = await getRun(ws, id);
  const logs = await db.select().from(runLogs).where(eq(runLogs.runId, run.id)).orderBy(asc(runLogs.at)).limit(500);
  const wf = (run.definition as { workflow: WorkflowDefinition }).workflow;
  const byNode = new Map(steps.map((s) => [s.nodeId, s]));
  const live = ["queued", "running"].includes(run.status);
  const edit = can(ws.role, "edit");
  const h = <><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="id" value={run.id} /></>;
  return (
    <>
      <AutoRefresh active={live} intervalMs={2500} />
      <PageHeader title={run.workflowName} back={{ href: `/w/${ws.workspaceId}/runs`, label: "Workflow runs" }}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={run.status} /><span>started <Timestamp value={run.createdAt} tz={ws.timezone} /> · {run.trigger}</span></span>}
        actions={edit && <>
          {["queued", "running", "waiting"].includes(run.status) && <ActionForm action={runControlAction} showErrorBanner={false}>{h}<input type="hidden" name="op" value="cancel" /><ConfirmSubmit title="Cancel this run?" description="Running steps are stopped and pending approvals cancelled. Completed work is kept." confirmLabel="Cancel run">Cancel run</ConfirmSubmit></ActionForm>}
          {["failed", "cancelled"].includes(run.status) && <ActionForm action={runControlAction} showErrorBanner={false}>{h}<input type="hidden" name="op" value="retry" /><SubmitButton>Retry from failed step</SubmitButton></ActionForm>}
        </>} />
      {run.error && <div className="mb-5"><Notice tone="danger" title="Run failed">{run.error}</Notice></div>}
      {run.status === "waiting" && <div className="mb-5"><Notice tone="warning" title="Waiting for approval">This run continues automatically once the pending approval is decided. <Link className="underline" href={`/w/${ws.workspaceId}/approvals`}>Approvals</Link></Notice></div>}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Steps" />
          <ol className="divide-y divide-[var(--border)]">
            {wf.nodes.map((n, i) => {
              const s = byNode.get(n.id);
              const out = (s?.output ?? null) as Record<string, unknown> | null;
              return (
                <li key={n.id} className="flex gap-4 px-5 py-3.5">
                  <span className="tnum mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--surface-2)] text-[11.5px] font-semibold">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{n.label ?? nodeSpec(n.type)?.label ?? n.type}</span><code className="mono text-[11.5px] text-[var(--text-subtle)]">{n.type}</code>{s && <StatusBadge status={s.status} />}{(s?.attempt ?? 0) > 1 && <Badge>attempt {s!.attempt}</Badge>}{n.when && <Badge tone="warning">conditional</Badge>}</div>
                    {s?.error && <p className="mt-1 text-[12.5px] text-[var(--danger)]">{s.error}</p>}
                    {out && <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-[var(--text-muted)]">{Object.entries(out).filter(([k]) => !k.endsWith("Id")).map(([k, v]) => <span key={k}>{k}: {String(v)}</span>)}{outputLink(ws.workspaceId, out)}</div>}
                    {s?.startedAt && <div className="mt-0.5 text-[11.5px] text-[var(--text-subtle)]"><Timestamp value={s.startedAt} tz={ws.timezone} />{s.finishedAt && <> → <Timestamp value={s.finishedAt} tz={ws.timezone} /></>}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        </Card>
        <div className="space-y-6">
          <Card><CardHeader title="Input" /><div className="p-5"><KeyValue items={Object.entries(run.input as Record<string, string>).map(([k, v]) => [k, <code key={k} className="mono text-[12px]">{v}</code>])} /></div></Card>
          <Card><CardHeader title="Log" />{logs.length === 0 ? <p className="p-5 text-[13px] text-[var(--text-muted)]">No entries yet.</p> : <pre className="code-block m-4 max-h-[420px] whitespace-pre-wrap">{logs.map((l) => `${l.at.toISOString().slice(11, 19)} ${l.level} ${l.message}`).join("\n")}</pre>}</Card>
        </div>
      </div>
    </>
  );
}
