import { AutoRefresh } from "@/components/forms";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, MockBadge, Notice, PageHeader, ProgressBar, Section, StatusBadge, downloadHref } from "@/components/ui/kit";
import { utcToZonedLocal } from "@/lib/dates";
import { formatTimestamp, type MetadataSuggestions, type PublishMetadata } from "@/lib/metadata";
import { cancelPublishingAction, decideAction, saveMetadataAction, submitPublishingAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { listApprovals } from "@/server/services/approvals";
import { workspacePlaylists } from "@/server/services/channel";
import { getAsset, mediaUrl } from "@/server/services/media";
import { getPublishing } from "@/server/services/publishing";
import { can } from "@/server/tenancy";

export const metadata = { title: "Metadata" };

const CATEGORIES: [string, string][] = [["1", "Film & Animation"], ["2", "Autos & Vehicles"], ["10", "Music"], ["15", "Pets & Animals"], ["17", "Sports"], ["19", "Travel & Events"], ["20", "Gaming"], ["22", "People & Blogs"], ["23", "Comedy"], ["24", "Entertainment"], ["25", "News & Politics"], ["26", "Howto & Style"], ["27", "Education"], ["28", "Science & Technology"], ["29", "Nonprofits & Activism"]];

export default async function MetadataEditor({ params }: { params: Promise<{ ws: string; id: string }> }) {
  const { ws: wsId, id } = await params;
  const ws = await pageWs(wsId);
  const job = await getPublishing(ws, id);
  const m = job.metadata as PublishMetadata;
  const sug = (job.suggestions ?? {}) as Partial<MetadataSuggestions>;
  const [asset, playlists, approvals] = await Promise.all([getAsset(ws, job.outputAssetId), workspacePlaylists(ws), listApprovals(ws)]);
  const url = await mediaUrl(ws, asset, "original");
  const pending = approvals.find((a) => a.subjectId === job.id);
  const locked = ["uploading", "processing", "scheduled", "published", "cancelled"].includes(job.status);
  const edit = can(ws.role, "edit") && !locked;
  const h = <><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="id" value={job.id} /></>;
  const ytNotes = ((job.youtubeStatus ?? {}) as { notes?: string[] }).notes ?? [];
  const localPublishAt = m.publishAt ? utcToZonedLocal(m.publishAt, ws.timezone) : "";

  return (
    <>
      <AutoRefresh active={["uploading", "processing", "approved"].includes(job.status)} intervalMs={4000} />
      <PageHeader title={m.title} back={{ href: `/w/${ws.workspaceId}/publishing`, label: "Publishing" }}
        description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={job.status} />{job.isMock && <MockBadge />}{job.metadataProvider && <Badge>drafted by {job.metadataProvider}</Badge>}{job.youtubeVideoId && <a className="text-[var(--brand)] underline" href={`https://www.youtube.com/watch?v=${job.youtubeVideoId}`} target="_blank" rel="noreferrer">View on YouTube</a>}</span>}
        actions={<>
          {can(ws.role, "edit") && job.status === "draft" && <ActionForm action={submitPublishingAction} showErrorBanner={false}>{h}<SubmitButton>Submit for approval</SubmitButton></ActionForm>}
          {pending && can(ws.role, "approve") && <>
            <ActionForm action={decideAction} showErrorBanner={false}><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="id" value={pending.id} /><input type="hidden" name="decision" value="rejected" /><SubmitButton variant="secondary">Reject</SubmitButton></ActionForm>
            <ActionForm action={decideAction} showErrorBanner={false}><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="id" value={pending.id} /><input type="hidden" name="decision" value="approved" /><ConfirmSubmit variant="primary" danger={false} title="Approve upload to YouTube?" description={`This uploads the video to the connected channel as “${m.privacyStatus}”${m.publishAt ? `, scheduled for ${new Date(m.publishAt).toLocaleString("en-GB", { timeZone: ws.timezone })} (${ws.timezone})` : ""}.`} confirmLabel="Approve & upload">Approve & upload</ConfirmSubmit></ActionForm>
          </>}
          {can(ws.role, "edit") && !locked && <ActionForm action={cancelPublishingAction} showErrorBanner={false}>{h}<ConfirmSubmit variant="ghost" title="Cancel this publishing job?" description="It will not be uploaded." confirmLabel="Cancel job">Cancel</ConfirmSubmit></ActionForm>}
        </>} />

      {job.status === "uploading" && <div className="mb-5"><Card><CardBody><div className="mb-2 text-[13px] font-medium">Uploading to YouTube…</div><ProgressBar value={job.bytesUploaded} max={asset.sizeBytes} /></CardBody></Card></div>}
      {job.status === "processing" && <div className="mb-5"><Notice tone="info">Uploaded. YouTube is processing the video; this page updates when it finishes.</Notice></div>}
      {job.error && <div className="mb-5"><Notice tone="danger" title="Last attempt failed">{job.error}</Notice></div>}
      {ytNotes.length > 0 && <div className="mb-5"><Notice tone="info">{ytNotes.map((n) => <div key={n}>{n}</div>)}</Notice></div>}
      {pending && <div className="mb-5"><Notice tone="warning" title="Waiting for approval">The creator (workspace owner) or an agency admin must approve before anything is uploaded.</Notice></div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card><CardBody>
          <ActionForm action={saveMetadataAction} className="space-y-5">
            {h}
            <fieldset disabled={!edit} className="space-y-5">
              <Field label={`Title (${m.title.length}/100)`} htmlFor="title"><Input id="title" name="title" defaultValue={m.title} maxLength={100} required /></Field>
              <Field label="Description" htmlFor="description" hint="Up to 5000 bytes. Chapters below are added by the agent's template; edit freely."><Textarea id="description" name="description" rows={10} defaultValue={m.description} /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Tags (comma separated; 500 characters total)" htmlFor="tags"><Textarea id="tags" name="tags" rows={2} defaultValue={m.tags.join(", ")} /></Field>
                <Field label="Hashtags" htmlFor="hashtags"><Textarea id="hashtags" name="hashtags" rows={2} defaultValue={m.hashtags.join(", ")} /></Field>
              </div>
              <Field label="Chapters" htmlFor="chapters" hint="One per line: 0:00 Title. YouTube needs at least three, the first at 0:00, each ≥ 10 seconds."><Textarea id="chapters" name="chapters" rows={5} className="mono text-[12.5px]" defaultValue={m.chapters.map((c) => `${formatTimestamp(c.start)} ${c.title}`).join("\n")} /></Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Visibility" htmlFor="privacy"><Select id="privacy" name="privacyStatus" defaultValue={m.privacyStatus}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></Select></Field>
                <Field label="Schedule (optional)" htmlFor="publishAt" hint={`Workspace time (${ws.timezone}). Requires Private.`}><Input id="publishAt" name="publishAt" type="datetime-local" defaultValue={localPublishAt} /></Field>
                <Field label="Category" htmlFor="cat"><Select id="cat" name="categoryId" defaultValue={m.categoryId}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
                <Field label="Playlist" htmlFor="pl"><Select id="pl" name="playlistId" defaultValue={m.playlistId ?? ""}><option value="">None</option>{playlists.map((p) => <option key={p.id} value={p.youtubePlaylistId}>{p.title}</option>)}</Select></Field>
                <Field label="Language" htmlFor="lang"><Input id="lang" name="language" defaultValue={m.language} /></Field>
                <div className="pt-7"><Checkbox name="madeForKids" defaultChecked={m.madeForKids} label="Made for kids" /></div>
              </div>
              <Field label="Pinned comment (draft)" htmlFor="pc" hint="The YouTube API cannot pin comments; post and pin this yourself."><Textarea id="pc" name="pinnedComment" rows={2} defaultValue={m.pinnedComment} /></Field>
              {edit && <SubmitButton>Save metadata</SubmitButton>}
            </fieldset>
          </ActionForm>
        </CardBody></Card>

        <div className="space-y-6">
          <Card className="overflow-hidden">{url && <video src={url} controls className="aspect-video w-full bg-black" />}<CardBody className="text-[12.5px]"><a className="text-[var(--brand)]" href={url ? downloadHref(url) : "#"}>Download video</a></CardBody></Card>
          <Card>
            <CardHeader title="Agent suggestions" description="Recommendations only — pick, edit or ignore." />
            <CardBody className="space-y-5">
              {sug.titleOptions?.length ? <Section title="Title options"><ul className="space-y-1 text-[13px]">{sug.titleOptions.map((t) => <li key={t} className="rounded bg-[var(--surface-2)] px-2 py-1">{t}</li>)}</ul></Section> : null}
              {sug.thumbnailConcepts?.length ? <Section title="Thumbnail concepts"><ul className="space-y-2 text-[13px]">{sug.thumbnailConcepts.map((t, i) => <li key={i}><span className="font-medium">“{t.textOverlay}”</span> — {t.concept}</li>)}</ul><p className="text-[11.5px] text-[var(--text-muted)]">Custom thumbnails are uploaded in YouTube Studio (the API requires a verified channel).</p></Section> : null}
              {sug.playlistSuggestions?.length ? <Section title="Playlists"><ul className="text-[13px]">{sug.playlistSuggestions.map((p) => <li key={p.playlistId}><span className="font-medium">{p.title}</span> — {p.reason}</li>)}</ul></Section> : null}
              {sug.cta ? <Section title="Call to action"><p className="text-[13px]">{sug.cta}</p></Section> : null}
              {sug.notes?.length ? <Section title="Notes"><ul className="list-disc pl-4 text-[12.5px] text-[var(--text-muted)]">{sug.notes.map((n) => <li key={n}>{n}</li>)}</ul></Section> : null}
              {!sug.titleOptions?.length && <p className="text-[13px] text-[var(--text-muted)]">No AI suggestions (blank draft).</p>}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
