import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { jobs, runLogs } from "@/db/schema";
import { AutoRefresh } from "@/components/forms";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Card, CardHeader, EmptyState, PageHeader, ProgressBar, StatusBadge, Tabs, Timestamp } from "@/components/ui/kit";
import { jobControlAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { can } from "@/server/tenancy";
import { listRuns } from "@/server/workflow/engine";

export const metadata = { title: "Workflow runs" };

export default async function WsRuns({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ view?: string; job?: string }> }) {
  const ws = await pageWs((await params).ws);
  const sp = await searchParams;
  const view = sp.view === "jobs" || sp.job ? "jobs" : "runs";
  const runs = await listRuns(ws, 100);
  const jobRows = await db.select().from(jobs).where(eq(jobs.workspaceId, ws.workspaceId)).orderBy(desc(jobs.createdAt)).limit(100);
  const logs = sp.job ? await db.select().from(runLogs).where(and(eq(runLogs.jobId, sp.job), eq(runLogs.workspaceId, ws.workspaceId))).orderBy(runLogs.at) : [];
  const live = runs.some((r) => ["queued", "running"].includes(r.status)) || jobRows.some((j) => ["queued", "running"].includes(j.status));
  const edit = can(ws.role, "edit");
  const h = <input type="hidden" name="ws" value={ws.workspaceId} />;
  return (
    <>
      <AutoRefresh active={live} />
      <PageHeader title="Workflow runs" description="Agent runs and every background job for this client: transcription, rendering, uploads, syncs." />
      <Tabs active={view} items={[{ key: "runs", label: "Workflow runs", href: "?view=runs", count: runs.length }, { key: "jobs", label: "Background jobs", href: "?view=jobs" }]} />
      {view === "runs" ? (
        <Card className="overflow-hidden">{runs.length === 0 ? <EmptyState icon="activity" title="No runs yet" description="Start one from the Agent page." /> : (
          <div className="table-wrap"><table className="table-cl"><thead><tr><th>Workflow</th><th>Status</th><th>Trigger</th><th>Started</th><th>Finished</th><th>Error</th></tr></thead>
            <tbody>{runs.map((r) => <tr key={r.id}><td><Link href={`/w/${ws.workspaceId}/runs/${r.id}`} className="font-medium hover:text-[var(--brand)]">{r.workflowName}</Link></td><td><StatusBadge status={r.status} /></td><td className="text-[12.5px]">{r.trigger}</td><td><Timestamp value={r.createdAt} tz={ws.timezone} /></td><td><Timestamp value={r.finishedAt} tz={ws.timezone} /></td><td className="max-w-xs truncate text-[12.5px] text-[var(--danger)]">{r.error}</td></tr>)}</tbody></table></div>
        )}</Card>
      ) : (
        <div className="space-y-6">
          <Card className="overflow-hidden">{jobRows.length === 0 ? <EmptyState icon="activity" title="No jobs" /> : (
            <div className="table-wrap"><table className="table-cl"><thead><tr><th>Job</th><th>Status</th><th>Progress</th><th>Attempts</th><th>Created</th><th /></tr></thead>
              <tbody>{jobRows.map((j) => (
                <tr key={j.id} className={sp.job === j.id ? "bg-[var(--brand-soft)]" : ""}>
                  <td><Link className="mono text-[12.5px] hover:text-[var(--brand)]" href={`?job=${j.id}`}>{j.type}</Link>{j.error && <div className="max-w-sm truncate text-[12px] text-[var(--danger)]">{j.error}</div>}</td>
                  <td><StatusBadge status={j.status} /></td>
                  <td className="w-36"><ProgressBar value={j.progress} />{j.progressNote && <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">{j.progressNote}</div>}</td>
                  <td className="tnum">{j.attempts}/{j.maxAttempts}</td><td><Timestamp value={j.createdAt} tz={ws.timezone} /></td>
                  <td className="text-right">{edit && (j.status === "failed" || j.status === "cancelled") && !j.runId && <ActionForm action={jobControlAction} showErrorBanner={false}>{h}<input type="hidden" name="id" value={j.id} /><input type="hidden" name="op" value="retry" /><SubmitButton size="sm" variant="secondary">Retry</SubmitButton></ActionForm>}
                    {edit && (j.status === "queued" || j.status === "running") && <ActionForm action={jobControlAction} showErrorBanner={false}>{h}<input type="hidden" name="id" value={j.id} /><input type="hidden" name="op" value="cancel" /><SubmitButton size="sm" variant="ghost">Cancel</SubmitButton></ActionForm>}</td>
                </tr>
              ))}</tbody></table></div>
          )}</Card>
          {sp.job && (
            <Card><CardHeader title="Job log" />
              {logs.length === 0 ? <EmptyState compact title="No log entries" /> : <pre className="code-block m-5 max-h-96">{logs.map((l) => `${l.at.toISOString()}  ${l.level.toUpperCase().padEnd(5)}  ${l.message}`).join("\n")}</pre>}
            </Card>
          )}
        </div>
      )}
    </>
  );
}
