import Link from "next/link";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, workspaces } from "@/db/schema";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, PageHeader, StatCard, StatusBadge, Timestamp } from "@/components/ui/kit";
import { pageOrg } from "@/server/page-ctx";
import { agencyOverview } from "@/server/services/workspaces";

export const metadata = { title: "Agency overview" };

export default async function AgencyOverview() {
  const org = await pageOrg();
  const s = await agencyOverview(org.orgId);
  const activity = await db.select({ a: auditLogs, ws: workspaces.name }).from(auditLogs).leftJoin(workspaces, eq(workspaces.id, auditLogs.workspaceId))
    .where(inArray(auditLogs.orgId, [org.orgId])).orderBy(desc(auditLogs.at)).limit(12);
  return (
    <>
      <PageHeader eyebrow={org.orgName} title="Overview" description="Live counts from every client workspace."
        actions={<><ButtonLink href="/agency/clients?new=1" variant="secondary">New client</ButtonLink><ButtonLink href="/agency/deploy">Deploy an agent</ButtonLink></>} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <StatCard label="Clients" value={s.clients} icon="users" href="/agency/clients" definition="Active client workspaces" />
        <StatCard label="Active agents" value={s.activeAgents} icon="rocket" tone="brand" href="/agency/deploy" definition="Deployments with status active" />
        <StatCard label="Videos rendered" value={s.videosRendered} icon="film" tone="success" definition="Successful renders (draft and final) stored" />
        <StatCard label="Published" value={s.published} icon="upload" tone="success" definition="Uploads that reached published or scheduled on YouTube" />
        <StatCard label="Pending approvals" value={s.pendingApprovals} icon="checkCircle" tone={s.pendingApprovals ? "warning" : "default"} definition="Open approval requests across clients" />
        <StatCard label="Failed jobs" value={s.failedJobs} icon="alert" tone={s.failedJobs ? "danger" : "default"} href="/agency/runs?status=failed" definition="Background jobs that exhausted their retries" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent workflow runs" action={<Link className="text-[13px] font-medium text-[var(--brand)]" href="/agency/runs">All runs</Link>} />
          {s.recentRuns.length === 0 ? <EmptyState compact icon="activity" title="No runs yet" description="Runs appear when a deployed agent starts a workflow." /> : (
            <ul className="divide-y divide-[var(--border)]">
              {s.recentRuns.map(({ run, ws }) => (
                <li key={run.id}><Link href={`/w/${run.workspaceId}/runs/${run.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--surface-2)]">
                  <div className="min-w-0 flex-1"><div className="truncate text-[13.5px] font-medium">{run.workflowName}</div><div className="truncate text-[12px] text-[var(--text-muted)]">{ws} · <Timestamp value={run.createdAt} /></div></div>
                  <StatusBadge status={run.status} />
                </Link></li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="Recent activity" action={<Link className="text-[13px] font-medium text-[var(--brand)]" href="/agency/audit">Audit log</Link>} />
          {activity.length === 0 ? <EmptyState compact icon="history" title="Nothing yet" /> : (
            <ul className="divide-y divide-[var(--border)]">
              {activity.map(({ a, ws }) => (
                <li key={a.id} className="px-5 py-2.5 text-[13px]"><span className="font-medium">{a.summary}</span><div className="text-[12px] text-[var(--text-muted)]">{ws ? `${ws} · ` : ""}<Timestamp value={a.at} /></div></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
