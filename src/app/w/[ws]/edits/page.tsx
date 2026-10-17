import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Card, EmptyState, PageHeader, StatusBadge, Timestamp, fmtDuration } from "@/components/ui/kit";
import type { Edl } from "@/lib/edl";
import { pageWs } from "@/server/page-ctx";
import { listEdits } from "@/server/services/editing";

export const metadata = { title: "Edits" };

export default async function Edits({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await pageWs((await params).ws);
  const edits = await listEdits(ws);
  return (
    <>
      <PageHeader title="Edits" description="Each edit is a non-destructive edit-decision list over the original footage. Review, adjust, approve, then render." actions={<ButtonLink href={`/w/${ws.workspaceId}/media`} variant="secondary">Propose an edit from a recording</ButtonLink>} />
      <Card className="overflow-hidden">
        {edits.length === 0 ? <EmptyState icon="scissors" title="No edits yet" description="Upload a recording and choose Propose edit — or run the footage workflow from the Agent page." /> : (
          <div className="table-wrap"><table className="table-cl">
            <thead><tr><th>Edit</th><th>Format</th><th>Mode</th><th>Status</th><th>Length</th><th>Version</th><th>Updated</th></tr></thead>
            <tbody>{edits.map((e) => {
              const edl = e.edl as Edl;
              return (
                <tr key={e.id}><td><Link href={`/w/${ws.workspaceId}/edits/${e.id}`} className="font-medium hover:text-[var(--brand)]">{e.title}</Link></td><td>{e.format === "short" ? <Badge tone="brand">short</Badge> : "long"}</td><td className="text-[12.5px]">{e.editingMode.replace("_", "-")}</td><td><StatusBadge status={e.status} /></td><td className="tnum">{fmtDuration(edl.clips.reduce((s, c) => s + c.out - c.in, 0))}</td><td className="tnum">v{e.edlVersion}{e.approvedVersion === e.edlVersion && " ✓"}</td><td><Timestamp value={e.updatedAt} tz={ws.timezone} /></td></tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </>
  );
}
