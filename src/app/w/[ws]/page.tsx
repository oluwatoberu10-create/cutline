import Link from "next/link";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { contentIdeas, jobs, mediaAssets, publishingJobs } from "@/db/schema";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader, EmptyState, Notice, PageHeader, SetupRequired, StatCard, StatusBadge, Timestamp } from "@/components/ui/kit";
import { pageWs } from "@/server/page-ctx";
import { usageFor } from "@/server/services/audit";
import { primaryChannel } from "@/server/services/channel";
import { getDeployment } from "@/server/services/deployments";
import { listConnections } from "@/server/services/integrations";
import { listApprovals } from "@/server/services/approvals";
import { listRuns } from "@/server/workflow/engine";

export const metadata = { title: "Workspace" };

export default async function WorkspaceHome({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ denied?: string }> }) {
  const ws = await pageWs((await params).ws);
  const { denied } = await searchParams;
  const b = `/w/${ws.workspaceId}`;
  const [dep, channel, conns, approvals, runs, usage, [ideas], [assets], [failed], [published]] = await Promise.all([
    getDeployment(ws), primaryChannel(ws), listConnections(ws), listApprovals(ws), listRuns(ws, 6), usageFor(ws.workspaceId),
    db.select({ n: count() }).from(contentIdeas).where(and(eq(contentIdeas.workspaceId, ws.workspaceId), inArray(contentIdeas.status, ["proposed", "saved", "approved"]))),
    db.select({ n: count() }).from(mediaAssets).where(and(eq(mediaAssets.workspaceId, ws.workspaceId), eq(mediaAssets.role, "source"), isNull(mediaAssets.deletedAt))),
    db.select({ n: count() }).from(jobs).where(and(eq(jobs.workspaceId, ws.workspaceId), eq(jobs.status, "failed"))),
    db.select({ n: count() }).from(publishingJobs).where(and(eq(publishingJobs.workspaceId, ws.workspaceId), inArray(publishingJobs.status, ["published", "scheduled"]))),
  ]);
  const hasYt = conns.some((c) => c.kind === "youtube");
  const hasLlm = conns.some((c) => c.kind === "llm");
  const L = ws.settings.limits;
  return (
    <>
      {denied && <div className="mb-4"><Notice tone="warning">Your role in this workspace does not allow that page.</Notice></div>}
      <PageHeader eyebrow="Client workspace" title={ws.workspaceName}
        description={dep ? <>Agent: <strong>{dep.templateName}</strong> v{dep.version} · <StatusBadge status={dep.d.status} /></> : "No agent deployed yet — manual tools work with the starter configuration."}
        actions={<><ButtonLink variant="secondary" href={`${b}/media`}>Upload footage</ButtonLink><ButtonLink href={`${b}/agent`}>Run the agent</ButtonLink></>} />

      {(!dep || !channel || !hasLlm) && (
        <div className="mb-6 grid gap-3 md:grid-cols-3">
          {!dep && <SetupRequired title="Deploy an agent" action={ws.role === "agency_admin" ? <ButtonLink size="sm" href={`/agency/deploy?ws=${ws.workspaceId}`}>Start deployment</ButtonLink> : undefined}>Workflows run once an agency admin deploys a blueprint to this workspace.</SetupRequired>}
          {!channel && <SetupRequired title="Connect the channel" action={<ButtonLink size="sm" variant="secondary" href={`${b}/integrations`}>Connect</ButtonLink>}>{hasYt ? "Run a channel sync to import videos." : "Connect the creator's YouTube channel (OAuth) or add a public channel URL."}</SetupRequired>}
          {!hasLlm && <SetupRequired title="Add an AI provider" action={<ButtonLink size="sm" variant="secondary" href={`${b}/integrations`}>Add key</ButtonLink>}>Ideas, highlights and metadata need a language model. Agency-shared providers are used when allowed.</SetupRequired>}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Pending approvals" value={approvals.length} icon="checkCircle" tone={approvals.length ? "warning" : "default"} href={`${b}/approvals`} />
        <StatCard label="Active ideas" value={Number(ideas.n)} icon="lightbulb" href={`${b}/ideas`} />
        <StatCard label="Recordings" value={Number(assets.n)} icon="film" href={`${b}/media`} />
        <StatCard label="Published" value={Number(published.n)} icon="upload" tone="success" href={`${b}/publishing`} />
        <StatCard label="Failed jobs" value={Number(failed.n)} icon="alert" tone={Number(failed.n) ? "danger" : "default"} href={`${b}/runs`} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card>
          <CardHeader title="Recent runs" action={<Link href={`${b}/runs`} className="text-[13px] font-medium text-[var(--brand)]">All runs</Link>} />
          {runs.length === 0 ? <EmptyState compact icon="activity" title="No runs yet" /> : (
            <ul className="divide-y divide-[var(--border)]">{runs.map((r) => (
              <li key={r.id}><Link href={`${b}/runs/${r.id}`} className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--surface-2)]"><span className="flex-1 text-[13.5px] font-medium">{r.workflowName}</span><span className="text-[12px] text-[var(--text-muted)]"><Timestamp value={r.createdAt} tz={ws.timezone} /></span><StatusBadge status={r.status} /></Link></li>
            ))}</ul>
          )}
        </Card>
        <Card>
          <CardHeader title="This month's usage" description="Against the workspace's processing limits." />
          <ul className="space-y-3 p-5 text-[13px]">
            {([["Render minutes", usage.render_minutes, L.monthlyRenderMinutes], ["Transcription minutes", usage.transcription_minutes, L.monthlyTranscriptionMinutes], ["LLM calls", usage.llm_calls, L.monthlyLlmCalls]] as const).map(([l, u, max]) => (
              <li key={l}><div className="flex justify-between"><span>{l}</span><span className="tnum text-[var(--text-muted)]">{Math.round(u)} / {max}</span></div><div className="mt-1 h-1.5 rounded-full bg-[var(--surface-3)]"><div className="h-full rounded-full bg-[var(--brand)]" style={{ width: `${Math.min(100, (u / Math.max(1, max)) * 100)}%` }} /></div></li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
