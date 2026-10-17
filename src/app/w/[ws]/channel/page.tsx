import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Input } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, MockBadge, Notice, PageHeader, Section, SetupRequired, Timestamp, fmtDuration } from "@/components/ui/kit";
import { addPublicChannelAction, queueJobAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { channelVideos, latestAnalysis, primaryChannel, type Access, type Measured } from "@/server/services/channel";
import { can } from "@/server/tenancy";

export const metadata = { title: "Channel insights" };

type Hyp = { summary: string; items: { kind: string; statement: string; evidence: string; videoIds: string[]; confidence: string }[] };
const fmt = (n: number | null | undefined) => (n == null ? "—" : new Intl.NumberFormat("en", { notation: "compact" }).format(n));

export default async function ChannelPage({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await pageWs((await params).ws);
  const [ch, analysis, vids] = await Promise.all([primaryChannel(ws), latestAnalysis(ws), channelVideos(ws, 300)]);
  const edit = can(ws.role, "edit");
  const hidden = <input type="hidden" name="ws" value={ws.workspaceId} />;
  const m = analysis?.measured as (Measured & { llmNote?: string | null }) | undefined;
  const hyp = analysis?.hypotheses as Hyp | null | undefined;
  const titleOf = new Map(vids.map((v) => [v.youtubeVideoId, v.title]));

  return (
    <>
      <PageHeader title="Channel insights" description="Measured findings come straight from the channel's data. Hypotheses are the model's interpretation and are labelled as such — nothing here predicts views or rankings."
        actions={edit && ch && <>
          <ActionForm action={queueJobAction} showErrorBanner={false}>{hidden}<input type="hidden" name="type" value="channel.sync" /><SubmitButton variant="secondary">Sync now</SubmitButton></ActionForm>
          <ActionForm action={queueJobAction} showErrorBanner={false}>{hidden}<input type="hidden" name="type" value="channel.analyze" /><SubmitButton>Analyse</SubmitButton></ActionForm>
        </>} />

      {!ch ? (
        <div className="grid gap-4 md:grid-cols-2">
          <SetupRequired title="Connect with YouTube (recommended)" action={<Link className="text-[13px] font-medium text-[var(--brand)]" href={`/w/${ws.workspaceId}/integrations`}>Go to Integrations</Link>}>OAuth gives access to the channel's uploads, playlists and — when granted — YouTube Analytics.</SetupRequired>
          <Card><CardBody>
            <div className="text-[14px] font-semibold">Or research a public channel</div>
            <p className="mt-1 text-[13px] text-[var(--text-muted)]">Public data only (titles, views, durations). Needs YOUTUBE_API_KEY on the installation.</p>
            {edit && <ActionForm action={addPublicChannelAction} className="mt-3 flex gap-2">{hidden}<Input name="url" placeholder="https://youtube.com/@handle" aria-label="Channel URL" required /><SubmitButton>Add</SubmitButton></ActionForm>}
          </CardBody></Card>
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardBody className="flex flex-wrap items-center gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed/third-party URLs must not be cached by the image optimizer */}
{ch.thumbnailUrl && <img src={ch.thumbnailUrl} alt="" className="h-14 w-14 rounded-full" referrerPolicy="no-referrer" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[17px] font-semibold">{ch.title}<Badge tone={ch.source === "oauth" ? "success" : "info"}>{ch.source === "oauth" ? "Connected (OAuth)" : "Public data"}</Badge></div>
                <div className="text-[13px] text-[var(--text-muted)]">{ch.handle ?? ch.youtubeChannelId} · {fmt(ch.subscriberCount)} subscribers · {fmt(ch.videoCount)} videos · {fmt(ch.viewCount)} views · synced <Timestamp value={ch.lastSyncedAt} tz={ws.timezone} /></div>
              </div>
            </CardBody>
            {Object.keys(ch.access as Access).length > 0 && (
              <div className="grid gap-px border-t border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
                {Object.entries(ch.access as Access).map(([k, a]) => (
                  <div key={k} className="bg-[var(--surface)] px-4 py-3"><div className="flex items-center gap-2 text-[12.5px] font-semibold capitalize">{k}<Badge tone={a.available ? "success" : "neutral"}>{a.available ? "available" : "not available"}</Badge></div><div className="mt-1 text-[12px] text-[var(--text-muted)]">{a.reason}</div></div>
                ))}
              </div>
            )}
          </Card>

          {!analysis ? <Card><EmptyState icon="chart" title="No analysis yet" description="Sync the channel, then run an analysis." /></Card> : (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader title="Measured findings" description={<>From {m!.videoCount} synced videos{m!.analyticsVideos ? `, ${m!.analyticsVideos} with Analytics` : ""} · <Timestamp value={analysis.createdAt} tz={ws.timezone} /></>} />
                <CardBody className="space-y-6">
                  <div className="grid grid-cols-3 gap-3 text-center">
                    <div><div className="tnum text-[20px] font-bold">{fmt(m!.medianViews)}</div><div className="text-[11.5px] text-[var(--text-muted)]">median views</div></div>
                    <div><div className="tnum text-[20px] font-bold">{fmtDuration(m!.medianDurationSeconds)}</div><div className="text-[11.5px] text-[var(--text-muted)]">median length</div></div>
                    <div><div className="tnum text-[20px] font-bold">{m!.formatMix.shorts.count}/{m!.formatMix.long.count}</div><div className="text-[11.5px] text-[var(--text-muted)]">shorts / long-form</div></div>
                  </div>
                  <Section title="Uploads per month">
                    <div className="flex h-20 items-end gap-1">{m!.uploadsByMonth.map((u) => { const max = Math.max(...m!.uploadsByMonth.map((x) => x.count)); return <div key={u.month} className="flex-1 rounded-t bg-[var(--brand)]/70" style={{ height: `${(u.count / Math.max(1, max)) * 100}%` }} title={`${u.month}: ${u.count}`} />; })}</div>
                  </Section>
                  <Section title="Most viewed">
                    <ol className="space-y-1.5 text-[13px]">{m!.topByViews.slice(0, 5).map((v) => <li key={v.youtubeId} className="flex gap-2"><span className="flex-1 truncate">{v.title}</span><span className="tnum text-[var(--text-muted)]">{fmt(v.views)}</span></li>)}</ol>
                  </Section>
                  <Section title="Recurring topics (title terms in 2+ videos)">
                    <div className="flex flex-wrap gap-1.5">{m!.topics.slice(0, 16).map((t) => <Badge key={t.term} tone={(t.vsChannelMedian ?? 0) >= 1.5 ? "success" : "neutral"} title={`${t.videos} videos · median views ${t.vsChannelMedian ?? "?"}× channel median`}>{t.term} · {t.videos}{t.vsChannelMedian ? ` · ${t.vsChannelMedian}×` : ""}</Badge>)}</div>
                  </Section>
                  {m!.repeatedRecently.length > 0 && <Section title="Repeated in recent uploads"><div className="flex flex-wrap gap-1.5">{m!.repeatedRecently.map((r) => <Badge key={r.term} tone="warning">{r.term} · {r.inLastUploads}/{r.of}</Badge>)}</div></Section>}
                  {m!.followUpCandidates.length > 0 && <Section title="Follow-up candidates (≥ 2× median views)"><ul className="space-y-1 text-[13px]">{m!.followUpCandidates.slice(0, 5).map((v) => <li key={v.youtubeId} className="truncate">{v.title}</li>)}</ul></Section>}
                  {m!.goalCoverage.length > 0 && <Section title="Stated goals vs recent titles"><div className="flex flex-wrap gap-1.5">{m!.goalCoverage.map((g) => <Badge key={g.term} tone={g.inRecentTitles ? "success" : "neutral"}>{g.term}{g.inRecentTitles ? "" : " — absent"}</Badge>)}</div></Section>}
                </CardBody>
              </Card>
              <Card>
                <CardHeader title={<span className="flex items-center gap-2">Hypotheses {analysis.isMock && <MockBadge />}</span>} description={analysis.provider ? `Generated by ${analysis.provider} / ${analysis.model}. Treat as interpretations to test, not facts.` : undefined} />
                <CardBody>
                  {!hyp ? <Notice tone="warning" title="No AI hypotheses">{m!.llmNote ?? "The analysis ran without a language model."}</Notice> : (
                    <div className="space-y-4">
                      <p className="prose-cl text-[var(--text-muted)]">{hyp.summary}</p>
                      {hyp.items.map((h, i) => (
                        <div key={i} className="rounded-[var(--radius-field)] border border-[var(--border)] p-3">
                          <div className="flex flex-wrap items-center gap-2"><Badge tone="brand">{h.kind.replace(/_/g, " ")}</Badge><Badge>{h.confidence} confidence</Badge></div>
                          <p className="mt-2 text-[13.5px] font-medium">{h.statement}</p>
                          <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">Evidence: {h.evidence}</p>
                          {h.videoIds.length > 0 && <p className="mt-1 text-[12px] text-[var(--text-subtle)]">Videos: {h.videoIds.map((id) => titleOf.get(id) ?? id).join(" · ")}</p>}
                        </div>
                      ))}
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          )}

          <Card className="overflow-hidden">
            <CardHeader title="Synced videos" description={`${vids.length} video${vids.length === 1 ? "" : "s"}`} />
            {vids.length === 0 ? <EmptyState compact title="No videos synced" /> : (
              <div className="table-wrap max-h-[480px]"><table className="table-cl">
                <thead><tr><th>Title</th><th>Published</th><th>Length</th><th>Views</th><th>Avg viewed</th></tr></thead>
                <tbody>{vids.map((v) => (
                  <tr key={v.id}><td className="max-w-md truncate"><a className="hover:text-[var(--brand)]" href={`https://www.youtube.com/watch?v=${v.youtubeVideoId}`} target="_blank" rel="noreferrer">{v.title}</a></td><td className="whitespace-nowrap"><Timestamp value={v.publishedAt} tz={ws.timezone} /></td><td className="tnum">{fmtDuration(v.durationSeconds)}</td><td className="tnum">{fmt(v.viewCount)}</td><td className="tnum">{(v.analytics as { averageViewPercentage?: number } | null)?.averageViewPercentage != null ? `${Math.round((v.analytics as { averageViewPercentage: number }).averageViewPercentage)}%` : "—"}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
