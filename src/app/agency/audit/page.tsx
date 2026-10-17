import Link from "next/link";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs, users, workspaces } from "@/db/schema";
import { Card, EmptyState, PageHeader, Timestamp } from "@/components/ui/kit";
import { pageOrg } from "@/server/page-ctx";

export const metadata = { title: "Audit log" };

export default async function Audit({ searchParams }: { searchParams: Promise<{ before?: string }> }) {
  const org = await pageOrg();
  const { before } = await searchParams;
  const cutoff = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : null;
  const rows = await db.select({ a: auditLogs, actor: users.name, ws: workspaces.name }).from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId)).leftJoin(workspaces, eq(workspaces.id, auditLogs.workspaceId))
    .where(and(eq(auditLogs.orgId, org.orgId), cutoff ? lt(auditLogs.at, cutoff) : undefined)).orderBy(desc(auditLogs.at)).limit(100);
  return (
    <>
      <PageHeader title="Audit log" description="Connections, approvals, publishing, deployments, blueprint imports and exports, and other significant actions. Metadata is redacted of anything secret-shaped." />
      <Card className="overflow-hidden">
        {rows.length === 0 ? <EmptyState icon="history" title="No entries" /> : (
          <div className="table-wrap"><table className="table-cl">
            <thead><tr><th>When</th><th>Who</th><th>Client</th><th>Action</th><th>Summary</th></tr></thead>
            <tbody>{rows.map(({ a, actor, ws }) => (
              <tr key={a.id}><td className="whitespace-nowrap"><Timestamp value={a.at} /></td><td>{actor ?? <span className="text-[var(--text-muted)]">system</span>}</td><td>{ws ?? "—"}</td><td className="mono text-[12px]">{a.action}</td><td className="text-[13px]">{a.summary}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </Card>
      {rows.length === 100 && <div className="mt-4 text-center"><Link className="text-[13px] font-medium text-[var(--brand)]" href={`?before=${rows[rows.length - 1].a.at.toISOString()}`}>Older entries</Link></div>}
    </>
  );
}
