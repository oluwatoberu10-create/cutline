import Link from "next/link";
import { AutoRefresh } from "@/components/forms";
import { ClipOrder, EditPreview } from "@/components/edit-preview";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, ProgressBar, Section, StatusBadge, Tabs, Timestamp, downloadHref, fmtDuration } from "@/components/ui/kit";
import type { Edl, TranscriptSegment } from "@/lib/edl";
import {
  addSourceAction, adjustCutAction, approveEditAction, captionEditAction, createPublishingAction, createShortAction, edlSettingsAction, manualCutAction,
  renderAction, requestRevisionAction, restoreRevisionAction, suggestionAction,
} from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { effectiveConfig } from "@/server/services/agent-config";
import { getEdit, getTranscript, revisions, suggestionsFor } from "@/server/services/editing";
import { getAsset, listAssets, mediaUrl } from "@/server/services/media";
import { rendersFor } from "@/server/services/render";
import { signedMediaPath } from "@/server/storage";
import { can } from "@/server/tenancy";

export const metadata = { title: "Edit" };

const TYPE_LABEL: Record<string, string> = { pause: "Pause", filler: "Filler word", repeat: "Repeated take", remove: "AI: unusable", manual: "Removed by you", hook: "AI: hook", quote: "AI: quote", short_clip: "AI: short clip", topic_change: "AI: topic change" };
const REMOVALS = new Set(["pause", "filler", "repeat", "remove", "manual"]);

export default async function EditPage({ params, searchParams }: { params: Promise<{ ws: string; id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { ws: wsId, id } = await params;
  const ws = await pageWs(wsId);
  const tab = (await searchParams).tab ?? "cuts";
  const ep = await getEdit(ws, id);
  const edl = ep.edl as Edl;
  const [suggestions, renders, revs, { config }, sources, brand, intros, outros] = await Promise.all([
    suggestionsFor(ws, id), rendersFor(ws, id), revisions(ws, id), effectiveConfig(ws), listAssets(ws, { role: "source" }), listAssets(ws, { role: "brand" }), listAssets(ws, { role: "intro" }), listAssets(ws, { role: "outro" }),
  ]);
  const src0 = await getAsset(ws, edl.sources[0].assetId).catch(() => null);
  const transcript = src0 ? await getTranscript(ws, src0.id) : null;
  const segments = (transcript?.segments ?? []) as TranscriptSegment[];
  const s1Clips = edl.clips.filter((c) => c.sourceId === edl.sources[0].id);
  const latest = renders.find((r) => r.status === "succeeded" && r.outputAssetId);
  const latestOut = latest ? await getAsset(ws, latest.outputAssetId!).catch(() => null) : null;
  const edit = can(ws.role, "edit"), approve = can(ws.role, "approve");
  const approvedCurrent = ep.approvedVersion === ep.edlVersion;
  const h = <><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="edit" value={ep.id} /></>;
  const live = renders.some((r) => r.status === "queued" || r.status === "running");
  const removals = suggestions.filter((s) => REMOVALS.has(s.type));
  const highlights = suggestions.filter((s) => !REMOVALS.has(s.type));
  const renderRows = await Promise.all(renders.map(async (r) => {
    const out = r.outputAssetId ? await getAsset(ws, r.outputAssetId).catch(() => null) : null;
    return { r, out, url: out ? await mediaUrl(ws, out, "original") : null };
  }));
  const proxyUrl = src0 ? await mediaUrl(ws, src0, "proxy") : null;
  const latestUrl = latestOut ? await mediaUrl(ws, latestOut, "original") : null;
  const finalRender = renders.find((r) => r.kind === "final" && r.status === "succeeded" && r.edlVersion === ep.edlVersion);

  return (
    <>
      <AutoRefresh active={live} />
      <PageHeader title={ep.title} back={{ href: `/w/${ws.workspaceId}/edits`, label: "Edits" }}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={ep.status} /><Badge>{ep.editingMode.replace("_", "-")} mode</Badge><Badge>version {ep.edlVersion}</Badge>{approvedCurrent && <Badge tone="success">current version approved</Badge>}{ep.format === "short" && <Badge tone="brand">short</Badge>}</span>}
        actions={edit && <>
          <ActionForm action={renderAction} showErrorBanner={false}>{h}<input type="hidden" name="kind" value="draft" /><SubmitButton variant="secondary">Render draft</SubmitButton></ActionForm>
          {approve && !approvedCurrent && <ActionForm action={approveEditAction} showErrorBanner={false}>{h}<SubmitButton>Approve version {ep.edlVersion}</SubmitButton></ActionForm>}
          {approvedCurrent && <ActionForm action={renderAction} showErrorBanner={false}>{h}<input type="hidden" name="kind" value="final" /><SubmitButton>Render final</SubmitButton></ActionForm>}
        </>} />

      {ep.editingMode === "review_first" && !approvedCurrent && <div className="mb-5"><Notice tone="info">Review-first: measured pauses, fillers and repeated takes are already applied to this draft. Restore anything you want back, then approve before the final render.</Notice></div>}
      {ep.editingMode === "assisted" && !approvedCurrent && <div className="mb-5"><Notice tone="info">Assisted: nothing is cut until you apply it. Review each proposal below.</Notice></div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="space-y-6">
          <Card><CardBody>
            <EditPreview src={proxyUrl} duration={src0?.durationSeconds ?? 0} clips={s1Clips} segments={segments}
              cuts={removals.filter((r) => r.assetId === src0?.id).map((r) => ({ start: r.start, end: r.end, type: r.type, status: r.status }))}
              outputSrc={latestUrl} />
            {!transcript && <p className="mt-3 text-[12.5px] text-[var(--text-muted)]">No transcript yet — only pause-based edits are possible. Transcribe the recording from the Media library for filler/repeat detection, captions and AI highlights.</p>}
          </CardBody></Card>

          <Card>
            <CardHeader title="Renders" description="A render only shows Succeeded after FFmpeg finishes and the output is verified." />
            {renders.length === 0 ? <EmptyState compact icon="film" title="No renders yet" /> : (
              <ul className="divide-y divide-[var(--border)]">{renderRows.map(({ r, out, url }) => {
                const p = r.output as { label: string };
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                    <Badge tone={r.kind === "final" ? "brand" : "neutral"}>{r.kind}</Badge>
                    <div className="min-w-0 flex-1"><div className="text-[13px] font-medium">{p.label} · version {r.edlVersion}</div><div className="text-[12px] text-[var(--text-muted)]"><Timestamp value={r.createdAt} tz={ws.timezone} />{out ? ` · ${fmtDuration(out.durationSeconds)} · ${out.width}×${out.height}` : ""}{r.error ? ` · ${r.error}` : ""}</div>{(r.status === "running" || r.status === "queued") && <ProgressBar className="mt-1.5 max-w-xs" value={r.progress} />}</div>
                    <StatusBadge status={r.status} />
                    {out && url && <a className="text-[12.5px] font-medium text-[var(--brand)]" href={downloadHref(url)}>Download</a>}
                    {out && r.captionsKey && <a className="text-[12.5px] font-medium text-[var(--brand)]" href={downloadHref(signedMediaPath(ws.workspaceId, out.id, "captions"))}>Captions .srt</a>}
                    {edit && r.kind === "final" && r.status === "succeeded" && config.modules.publishing.enabled && (
                      <><ActionForm action={createPublishingAction} showErrorBanner={false}><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="renderJobId" value={r.id} /><SubmitButton size="sm">Prepare publishing</SubmitButton></ActionForm>
                        <ActionForm action={createPublishingAction} showErrorBanner={false}><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="renderJobId" value={r.id} /><input type="hidden" name="useAi" value="false" /><SubmitButton size="sm" variant="ghost">Blank metadata</SubmitButton></ActionForm></>
                    )}
                  </li>
                );
              })}</ul>
            )}
            {finalRender && !config.modules.publishing.enabled && <CardBody className="border-t border-[var(--border)]"><p className="text-[12.5px] text-[var(--text-muted)]">Publishing is disabled for this workspace; download the final file to upload it yourself.</p></CardBody>}
          </Card>
        </div>

        <div className="space-y-4">
          <Tabs active={tab} items={[
            { key: "cuts", label: "Cuts", href: "?tab=cuts", count: removals.length },
            { key: "highlights", label: "Highlights", href: "?tab=highlights", count: highlights.length },
            { key: "captions", label: "Captions", href: "?tab=captions" },
            { key: "settings", label: "Settings", href: "?tab=settings" },
            { key: "history", label: "History", href: "?tab=history", count: revs.length },
          ]} />

          {tab === "cuts" && (
            <Card><CardBody className="space-y-4">
              {removals.length === 0 ? <p className="text-[13px] text-[var(--text-muted)]">No cuts proposed.</p> : (
                <ActionForm action={suggestionAction} className="space-y-2">
                  {h}
                  <ul className="max-h-[520px] space-y-1.5 overflow-y-auto">{removals.map((s) => (
                    <li key={s.id} className="rounded-[var(--radius-field)] border border-[var(--border)] p-2.5 text-[12.5px]">
                      <label className="flex items-start gap-2">
                        {edit && <input type="checkbox" name="id" value={s.id} className="mt-0.5 accent-[var(--brand)]" />}
                        <span className="flex-1"><span className="font-medium">{TYPE_LABEL[s.type] ?? s.type}</span> <span className="tnum mono text-[var(--text-muted)]">{fmtDuration(s.start)}–{fmtDuration(s.end)}</span> <Badge tone={s.status === "accepted" ? "danger" : s.status === "rejected" ? "neutral" : "warning"}>{s.status === "accepted" ? "cut" : s.status === "rejected" ? "kept" : "proposed"}</Badge> <Badge>{s.origin}</Badge>
                          <span className="block text-[var(--text-muted)]">{s.reason}{s.text ? ` — “${s.text.slice(0, 80)}”` : ""}</span></span>
                      </label>
                      {edit && (
                        <details className="mt-1"><summary className="cursor-pointer text-[11.5px] text-[var(--text-subtle)]">Adjust timestamps</summary>
                          <ActionForm action={adjustCutAction} className="mt-1.5 flex gap-1.5">{h}<input type="hidden" name="id" value={s.id} /><Input name="start" defaultValue={s.start.toFixed(2)} className="h-8 text-[12px]" aria-label="Start" /><Input name="end" defaultValue={s.end.toFixed(2)} className="h-8 text-[12px]" aria-label="End" /><SubmitButton size="sm" variant="secondary">Set</SubmitButton></ActionForm>
                        </details>
                      )}
                    </li>
                  ))}</ul>
                  {edit && <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-3"><SubmitButton size="sm" name="status" value="accepted">Cut selected</SubmitButton><SubmitButton size="sm" variant="secondary" name="status" value="rejected">Restore selected</SubmitButton></div>}
                </ActionForm>
              )}
              {edit && src0 && (
                <ActionForm action={manualCutAction} resetOnSuccess className="space-y-2 border-t border-[var(--border)] pt-3">
                  {h}<input type="hidden" name="assetId" value={src0.id} />
                  <div className="text-[12.5px] font-semibold">Remove a segment</div>
                  <div className="grid grid-cols-3 gap-1.5"><Input name="start" placeholder="Start (s)" aria-label="Start seconds" className="h-8 text-[12px]" /><Input name="end" placeholder="End (s)" aria-label="End seconds" className="h-8 text-[12px]" /><SubmitButton size="sm" variant="secondary">Remove</SubmitButton></div>
                </ActionForm>
              )}
              {edit && (
                <div className="border-t border-[var(--border)] pt-3"><div className="mb-2 text-[12.5px] font-semibold">Sequence ({edl.clips.length} clips)</div>
                  <ClipOrder wsId={ws.workspaceId} editId={ep.id}
                    clips={edl.clips.map((c) => ({ id: c.id, label: `${edl.sources.find((x) => x.id === c.sourceId)?.id ?? ""} ${fmtDuration(c.in)}–${fmtDuration(c.out)}` }))} />
                  <ActionForm action={addSourceAction} className="mt-3 flex gap-1.5">{h}
                    <Select name="assetId" aria-label="Append a recording" className="h-8 text-[12px]">{sources.filter((s) => s.status === "ready" && !edl.sources.some((x) => x.assetId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.originalFilename}</option>)}</Select>
                    <SubmitButton size="sm" variant="secondary">Append</SubmitButton>
                  </ActionForm>
                </div>
              )}
            </CardBody></Card>
          )}

          {tab === "highlights" && (
            <Card><CardBody>
              {highlights.length === 0 ? <p className="text-[13px] text-[var(--text-muted)]">No AI highlights (needs a transcript and a language model).</p> : (
                <ul className="space-y-2">{highlights.map((s) => (
                  <li key={s.id} className="rounded-[var(--radius-field)] border border-[var(--border)] p-3 text-[12.5px]">
                    <div className="flex items-center gap-2"><span className="font-medium">{TYPE_LABEL[s.type] ?? s.type}</span><span className="tnum mono text-[var(--text-muted)]">{fmtDuration(s.start)}–{fmtDuration(s.end)}</span>{s.confidence != null && <Badge>{Math.round(s.confidence * 100)}%</Badge>}</div>
                    <p className="mt-1 text-[var(--text-muted)]">{s.reason}</p>
                    {s.text && <p className="mt-1 italic">“{s.text.slice(0, 200)}”</p>}
                    {edit && (s.type === "short_clip" || s.type === "hook" || s.type === "quote") && ep.format !== "short" && (
                      <ActionForm action={createShortAction} className="mt-2" showErrorBanner={false}>{h}<input type="hidden" name="suggestion" value={s.id} /><SubmitButton size="sm" variant="secondary">Make a {config.modules.editing.shorts.aspect} short</SubmitButton></ActionForm>
                    )}
                  </li>
                ))}</ul>
              )}
            </CardBody></Card>
          )}

          {tab === "captions" && (
            <Card><CardBody>
              {edl.captions.cues.length === 0 ? <p className="text-[13px] text-[var(--text-muted)]">No captions (transcribe the recording first).</p> : (
                <ActionForm action={captionEditAction} className="space-y-2">
                  {h}
                  <p className="text-[12px] text-[var(--text-muted)]">Captions follow the footage: cut segments drop their captions automatically. Showing the first 150 cues.</p>
                  <ol className="max-h-[520px] space-y-1.5 overflow-y-auto">{edl.captions.cues.slice(0, 150).map((c) => (
                    <li key={c.id} className="flex gap-2"><span className="tnum mono w-11 shrink-0 pt-2 text-[11px] text-[var(--text-subtle)]">{fmtDuration(c.start)}</span><input type="hidden" name="cueId" value={c.id} /><Textarea name="cueText" defaultValue={c.text} rows={2} className="min-h-0 text-[12.5px]" disabled={!edit} aria-label={`Caption at ${fmtDuration(c.start)}`} /></li>
                  ))}</ol>
                  {edit && <SubmitButton size="sm">Save captions</SubmitButton>}
                </ActionForm>
              )}
            </CardBody></Card>
          )}

          {tab === "settings" && (
            <Card><CardBody>
              <ActionForm action={edlSettingsAction} className="space-y-4">
                {h}
                <fieldset disabled={!edit} className="space-y-4">
                  <Section title="Output">
                    <div className="grid grid-cols-2 gap-2">
                      <Select name="presetId" defaultValue={edl.output.presetId} aria-label="Preset">{config.renderPresets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</Select>
                      <Select name="reframe" defaultValue={edl.output.reframe} aria-label="Reframe"><option value="fit">Fit (letterbox)</option><option value="center_crop">Centre crop</option><option value="blur_pad">Blurred background</option></Select>
                    </div>
                  </Section>
                  <Section title="Audio">
                    <div className="grid grid-cols-2 gap-2"><Select name="noiseReduction" defaultValue={edl.audio.noiseReduction} aria-label="Noise reduction"><option value="off">No noise reduction</option><option value="light">Light NR</option><option value="medium">Medium NR</option><option value="strong">Strong NR</option></Select><Input name="targetLufs" type="number" defaultValue={edl.audio.targetLufs} aria-label="Target LUFS" /></div>
                    <Checkbox name="normalize" defaultChecked={edl.audio.normalize} label="Normalise loudness" />
                  </Section>
                  <Section title="Transitions & captions">
                    <div className="grid grid-cols-2 gap-2"><Select name="transition" defaultValue={edl.transitions.type} aria-label="Transition"><option value="none">Hard cuts</option><option value="fade">Fades</option></Select><Input name="transitionMs" type="number" defaultValue={edl.transitions.durationMs} aria-label="Fade ms" /></div>
                    <Checkbox name="captions" defaultChecked={edl.captions.enabled} label="Captions" /><Checkbox name="burnIn" defaultChecked={edl.captions.burnIn} label="Burn captions into the video" />
                  </Section>
                  <Section title="Branding">
                    <Field label="Logo" htmlFor="logo"><Select id="logo" name="logoAssetId" defaultValue={edl.branding.logoAssetId ?? ""}><option value="">None</option>{brand.filter((b) => b.status === "ready").map((b) => <option key={b.id} value={b.id}>{b.originalFilename}</option>)}</Select></Field>
                    <Select name="logoPosition" defaultValue={edl.branding.logoPosition} aria-label="Logo position"><option value="top-right">Top right</option><option value="top-left">Top left</option><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option></Select>
                    <div className="grid grid-cols-2 gap-2">
                      <Select name="introAssetId" defaultValue={edl.branding.introAssetId ?? ""} aria-label="Intro"><option value="">No intro</option>{intros.filter((b) => b.status === "ready").map((b) => <option key={b.id} value={b.id}>{b.originalFilename}</option>)}</Select>
                      <Select name="outroAssetId" defaultValue={edl.branding.outroAssetId ?? ""} aria-label="Outro"><option value="">No outro</option>{outros.filter((b) => b.status === "ready").map((b) => <option key={b.id} value={b.id}>{b.originalFilename}</option>)}</Select>
                    </div>
                    <Field label="Lower thirds" htmlFor="lt" hint="One per line: start seconds | duration | name | subtitle"><Textarea id="lt" name="lowerThirds" rows={3} defaultValue={edl.lowerThirds.map((l) => `${l.start} | ${l.duration} | ${l.text} | ${l.subtext}`).join("\n")} /></Field>
                  </Section>
                  {edit && <SubmitButton>Save settings</SubmitButton>}
                </fieldset>
              </ActionForm>
            </CardBody></Card>
          )}

          {tab === "history" && (
            <Card><CardBody className="space-y-4">
              {edit && !approvedCurrent && (
                <ActionForm action={requestRevisionAction} className="space-y-2">{h}<Textarea name="note" rows={2} placeholder="What should change?" aria-label="Revision note" /><SubmitButton size="sm" variant="secondary">Request revisions</SubmitButton></ActionForm>
              )}
              <ul className="space-y-1.5">{revs.map((r) => (
                <li key={r.version} className="flex items-center gap-2 text-[12.5px]"><Badge tone={r.version === ep.edlVersion ? "brand" : "neutral"}>v{r.version}</Badge><span className="flex-1 truncate">{r.note}</span><span className="text-[var(--text-subtle)]"><Timestamp value={r.createdAt} tz={ws.timezone} /></span>
                  {edit && r.version !== ep.edlVersion && <ActionForm action={restoreRevisionAction} showErrorBanner={false}>{h}<input type="hidden" name="version" value={r.version} /><SubmitButton size="sm" variant="ghost">Restore</SubmitButton></ActionForm>}</li>
              ))}</ul>
              <Link href={`/w/${ws.workspaceId}/approvals`} className="block text-[12.5px] text-[var(--brand)]">Approvals queue →</Link>
            </CardBody></Card>
          )}
        </div>
      </div>
    </>
  );
}
