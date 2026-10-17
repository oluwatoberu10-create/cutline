import Link from "next/link";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { jobs, workflowRuns, workspaces } from "@/db/schema";
import { AutoRefresh } from "@/components/forms";
import { Card, CardHeader, EmptyState, PageHeader, ProgressBar, StatusBadge, Tabs, Timestamp } from "@/components/ui/kit";
import { pageOrg } from "@/server/page-ctx";

export const metadata = { title: "Workflow runs" };

const RUN_STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;

export default async function Runs({ searchParams }: { searchParams: Promise<{ view?: string; status?: string }> }) {
  const org = await pageOrg();
  const sp = await searchParams;
  const view = sp.view === "jobs" ? "jobs" : "runs";
  const status = RUN_STATUSES.find((s) => s === sp.status);
  const inOrg = eq(workspaces.orgId, org.orgId);

  const runConds: SQL[] = [inOrg];
  if (status) runConds.push(eq(workflowRuns.status, status));
  const runs = view === "runs" ? await db.select({ r: workflowRuns, ws: workspaces.name }).from(workflowRuns).innerJoin(workspaces, eq(workspaces.id, workflowRuns.workspaceId)).where(and(...runConds)).orderBy(desc(workflowRuns.createdAt)).limit(100) : [];
  const jobConds: SQL[] = [inOrg];
  if (status && ["queued", "running", "succeeded", "failed", "cancelled"].includes(status)) jobConds.push(eq(jobs.status, status as "queued"));
  const jobRows = view === "jobs" ? await db.select({ j: jobs, ws: workspaces.name }).from(jobs).innerJoin(workspaces, eq(workspaces.id, jobs.workspaceId)).where(and(...jobConds)).orderBy(desc(jobs.createdAt)).limit(150) : [];
  const live = runs.some((x) => ["queued", "running"].includes(x.r.status)) || jobRows.some((x) => ["queued", "running"].includes(x.j.status));
  void inArray;

  return (
    <>
      <AutoRefresh active={live} />
      <PageHeader title="Workflow runs" description="Every agent run and background job across all clients. Open one to inspect step logs, retry or cancel." />
      <Tabs active={view} items={[{ key: "runs", label: "Workflow runs", href: "?view=runs" }, { key: "jobs", label: "Background jobs", href: "?view=jobs" }]} />
      <div className="mb-4 flex flex-wrap gap-2 text-[13px]">
        <Link href={`?view=${view}`} className={!status ? "font-semibold" : "text-[var(--text-muted)]"}>All</Link>
        {RUN_STATUSES.map((s) => <Link key={s} href={`?view=${view}&status=${s}`} className={status === s ? "font-semibold" : "text-[var(--text-muted)]"}>{s}</Link>)}
      </div>
      <Card className="overflow-hidden">
        {view === "runs" ? (runs.length === 0 ? <EmptyState icon="activity" title="No runs" /> : (
          <div className="table-wrap"><table className="table-cl">
            <thead><tr><th>Workflow</th><th>Client</th><th>Status</th><th>Trigger</th><th>Started</th><th>Error</th></tr></thead>
            <tbody>{runs.map(({ r, ws }) => (
              <tr key={r.id}><td><Link className="font-medium hover:text-[var(--brand)]" href={`/w/${r.workspaceId}/runs/${r.id}`}>{r.workflowName}</Link></td><td>{ws}</td><td><StatusBadge status={r.status} /></td><td className="text-[12.5px]">{r.trigger}</td><td><Timestamp value={r.createdAt} /></td><td className="max-w-xs truncate text-[12.5px] text-[var(--danger)]">{r.error}</td></tr>
            ))}</tbody>
          </table></div>
        )) : (jobRows.length === 0 ? <EmptyState icon="activity" title="No jobs" /> : (
          <div className="table-wrap"><table className="table-cl">
            <thead><tr><th>Job</th><th>Client</th><th>Status</th><th>Progress</th><th>Attempts</th><th>Created</th><th>Error</th></tr></thead>
            <tbody>{jobRows.map(({ j, ws }) => (
              <tr key={j.id}><td className="mono text-[12.5px]"><Link href={`/w/${j.workspaceId}/runs?job=${j.id}`} className="hover:text-[var(--brand)]">{j.type}</Link></td><td>{ws}</td><td><StatusBadge status={j.status} /></td><td className="w-32"><ProgressBar value={j.progress} />{j.progressNote && <div className="mt-1 truncate text-[11px] text-[var(--text-muted)]">{j.progressNote}</div>}</td><td className="tnum">{j.attempts}/{j.maxAttempts}</td><td><Timestamp value={j.createdAt} /></td><td className="max-w-xs truncate text-[12.5px] text-[var(--danger)]">{j.error}</td></tr>
            ))}</tbody>
          </table></div>
        ))}
      </Card>
      <Card className="mt-6"><CardHeader title="About retries" description="Jobs retry with exponential backoff up to their attempt limit. Failures that retrying cannot fix (a missing integration, a rejected key, an unapproved upload) fail immediately with the reason. A crashed worker's jobs are reclaimed automatically when their lease expires." /></Card>
    </>
  );
}
