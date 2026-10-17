import Link from "next/link";
import { AutoRefresh } from "@/components/forms";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Badge, Card, CardBody, CardHeader, EmptyState, MockBadge, PageHeader, SetupRequired, StatusBadge, Timestamp, fmtDuration } from "@/components/ui/kit";
import type { PublishMetadata } from "@/lib/metadata";
import { createPublishingAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { effectiveConfig } from "@/server/services/agent-config";
import { listConnections } from "@/server/services/integrations";
import { listPublishing, renderOutputs } from "@/server/services/publishing";
import { can } from "@/server/tenancy";

export const metadata = { title: "Publishing" };

export default async function Publishing({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await pageWs((await params).ws);
  const [jobs, outputs, { config }, conns] = await Promise.all([listPublishing(ws), renderOutputs(ws), effectiveConfig(ws), listConnections(ws)]);
  const yt = conns.find((c) => c.kind === "youtube");
  const unpublished = outputs.filter((o) => o.render.kind === "final" && !jobs.some((j) => j.job.outputAssetId === o.asset.id));
  const live = jobs.some(({ job }) => ["uploading", "processing"].includes(job.status));
  const edit = can(ws.role, "edit");
  const p = config.modules.publishing;
  return (
    <>
      <AutoRefresh active={live} intervalMs={5000} />
      <PageHeader title="Publishing" description={<>Mode: <strong>{p.enabled ? { manual: "manual", approval: "approval-based", rule_based: "rule-based" }[p.mode] : "disabled"}</strong>. Nothing is uploaded, scheduled or made public without the required approval. SEO suggestions are recommendations, not ranking guarantees.</>} />
      {!p.enabled && <div className="mb-5"><SetupRequired title="Publishing is disabled for this workspace">The agent configuration has YouTube publishing turned off. Finished renders can still be downloaded from the Media library.</SetupRequired></div>}
      {p.enabled && (!yt || !yt.scopes.includes("youtube.upload")) && <div className="mb-5"><SetupRequired title={yt ? "The YouTube connection cannot upload" : "No YouTube channel connected"} action={<Link href={`/w/${ws.workspaceId}/integrations`} className="text-[13px] font-medium text-[var(--brand)]">Integrations</Link>}>{yt ? "Reconnect the channel with “Upload videos” enabled to grant the youtube.upload scope." : "Connect the creator's channel with upload permission. You can still prepare and approve metadata now."}</SetupRequired></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          <CardHeader title="Queue & history" />
          {jobs.length === 0 ? <EmptyState icon="upload" title="Nothing prepared yet" description="Prepare metadata for a finished final render." /> : (
            <ul className="divide-y divide-[var(--border)]">{jobs.map(({ job, asset }) => {
              const m = job.metadata as PublishMetadata;
              return (
                <li key={job.id}><Link href={`/w/${ws.workspaceId}/publishing/${job.id}`} className="flex flex-wrap items-center gap-3 px-5 py-3 hover:bg-[var(--surface-2)]">
                  <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate font-medium">{m.title}</span>{job.isMock && <MockBadge />}</div>
                    <div className="text-[12px] text-[var(--text-muted)]">{fmtDuration(asset.durationSeconds)} · {m.privacyStatus}{m.publishAt ? ` · scheduled ${new Date(m.publishAt).toLocaleString("en-GB", { timeZone: ws.timezone })}` : ""} · <Timestamp value={job.updatedAt} tz={ws.timezone} />{job.error ? ` · ${job.error}` : ""}</div></div>
                  {job.youtubeVideoId && <Badge tone="success">youtu.be/{job.youtubeVideoId}</Badge>}
                  <StatusBadge status={job.status} />
                </Link></li>
              );
            })}</ul>
          )}
        </Card>
        <Card className="h-fit">
          <CardHeader title="Ready to prepare" description="Final renders without publishing metadata." />
          {unpublished.length === 0 ? <CardBody><p className="text-[13px] text-[var(--text-muted)]">No unprepared final renders.</p></CardBody> : (
            <ul className="divide-y divide-[var(--border)]">{unpublished.map(({ render, asset }) => (
              <li key={render.id} className="space-y-2 px-5 py-3">
                <div className="truncate text-[13px] font-medium">{asset.originalFilename}</div>
                {edit && p.enabled && <div className="flex gap-2">
                  <ActionForm action={createPublishingAction} showErrorBanner={false}><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="renderJobId" value={render.id} /><SubmitButton size="sm">Draft with AI</SubmitButton></ActionForm>
                  <ActionForm action={createPublishingAction} showErrorBanner={false}><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="renderJobId" value={render.id} /><input type="hidden" name="useAi" value="false" /><SubmitButton size="sm" variant="secondary">Blank</SubmitButton></ActionForm>
                </div>}
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
