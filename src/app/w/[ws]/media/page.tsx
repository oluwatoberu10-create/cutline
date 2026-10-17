import Link from "next/link";
import { AutoRefresh } from "@/components/forms";
import { Uploader } from "@/components/uploader";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Input } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, StatusBadge, Tabs, Timestamp, downloadHref, fmtDuration } from "@/components/ui/kit";
import { formatBytes } from "@/lib/utils";
import { createProjectAction, deleteAssetAction, queueJobAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { listAssets, listProjects, mediaUrl, type Asset } from "@/server/services/media";
import { can } from "@/server/tenancy";
import { db } from "@/db";
import { transcripts } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Media library" };

const ROLES = [["source", "Recordings"], ["render", "Renders"], ["brand", "Brand"], ["intro", "Intros"], ["outro", "Outros"]] as const;

export default async function Media({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ role?: string; project?: string; idea?: string }> }) {
  const ws = await pageWs((await params).ws);
  const sp = await searchParams;
  const role = (ROLES.find(([r]) => r === sp.role)?.[0] ?? "source") as Asset["role"];
  const [assets, projects, tx] = await Promise.all([listAssets(ws, { role, projectId: sp.project }), listProjects(ws), db.select({ assetId: transcripts.assetId }).from(transcripts).where(eq(transcripts.workspaceId, ws.workspaceId))]);
  const hasTranscript = new Set(tx.map((t) => t.assetId));
  const thumbs = new Map(await Promise.all(assets.map(async (a) => [a.id, await mediaUrl(ws, a, "thumb")] as const)));
  const downloads = new Map(await Promise.all(assets.filter((a) => a.role === "render").map(async (a) => [a.id, await mediaUrl(ws, a, "original")] as const)));
  const edit = can(ws.role, "edit");
  const hidden = <input type="hidden" name="ws" value={ws.workspaceId} />;
  const busy = assets.some((a) => a.status === "processing" || a.status === "uploading");

  return (
    <>
      <AutoRefresh active={busy} />
      <PageHeader title="Media library" description="Originals are stored untouched; previews, speech audio and renders are separate working copies. Organised by project and recording date." />
      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div>
          <Tabs active={role} items={ROLES.map(([r, l]) => ({ key: r, label: l, href: `?role=${r}${sp.project ? `&project=${sp.project}` : ""}` }))} />
          {projects.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2 text-[12.5px]"><Link href={`?role=${role}`} className={!sp.project ? "font-semibold" : "text-[var(--text-muted)]"}>All projects</Link>{projects.map((p) => <Link key={p.id} href={`?role=${role}&project=${p.id}`} className={sp.project === p.id ? "font-semibold" : "text-[var(--text-muted)]"}>{p.title}</Link>)}</div>
          )}
          <Card className="overflow-hidden">
            {assets.length === 0 ? <EmptyState icon="film" title="Nothing here yet" description={role === "source" ? "Upload a raw recording to start editing." : role === "render" ? "Renders appear here after an edit is rendered." : "Upload brand assets for logo overlays, intros and outros."} /> : (
              <ul className="divide-y divide-[var(--border)]">{assets.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                  <div className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md bg-[var(--surface-3)]">{/* eslint-disable-next-line @next/next/no-img-element -- signed URLs expire; the image optimizer would cache them */}
                    {thumbs.get(a.id) ? <img src={thumbs.get(a.id)!} alt="" className="h-full w-full object-cover" /> : <span className="text-[11px] text-[var(--text-subtle)]">{a.kind}</span>}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="truncate text-[13.5px] font-medium">{a.originalFilename}</span><StatusBadge status={a.status} />{hasTranscript.has(a.id) && <Badge tone="info">transcribed</Badge>}</div>
                    <div className="mt-0.5 text-[12px] text-[var(--text-muted)]">{fmtDuration(a.durationSeconds)} · {a.width ? `${a.width}×${a.height}` : a.kind} · {formatBytes(a.sizeBytes)} · {a.recordedAt ? `recorded ${a.recordedAt} · ` : ""}<Timestamp value={a.createdAt} tz={ws.timezone} />{a.silences ? ` · ${(a.silences as unknown[]).length} pauses measured` : ""}</div>
                    {a.error && <div className="mt-1 text-[12px] text-[var(--danger)]">{a.error}</div>}
                  </div>
                  {edit && a.status === "ready" && (
                    <div className="flex flex-wrap items-center gap-2">
                      {a.role === "source" && a.hasAudio && !hasTranscript.has(a.id) && <ActionForm action={queueJobAction} showErrorBanner={false}>{hidden}<input type="hidden" name="type" value="media.transcribe" /><input type="hidden" name="assetId" value={a.id} /><SubmitButton size="sm" variant="secondary">Transcribe</SubmitButton></ActionForm>}
                      {a.role === "source" && <ActionForm action={queueJobAction} showErrorBanner={false}>{hidden}<input type="hidden" name="type" value="edit.propose" /><input type="hidden" name="assetId" value={a.id} /><input type="hidden" name="ideaId" value={sp.idea ?? ""} /><SubmitButton size="sm">Propose edit</SubmitButton></ActionForm>}
                      {a.role === "render" && downloads.get(a.id) && <a className="text-[13px] font-medium text-[var(--brand)]" href={downloadHref(downloads.get(a.id)!)}>Download</a>}
                    </div>
                  )}
                  {edit && <ActionForm action={deleteAssetAction} showErrorBanner={false}>{hidden}<input type="hidden" name="id" value={a.id} /><ConfirmSubmit variant="ghost" title="Delete this file?" description="The original and all working copies are permanently removed from storage. Edits that use it can no longer render." confirmLabel="Delete">Delete</ConfirmSubmit></ActionForm>}
                </li>
              ))}</ul>
            )}
          </Card>
        </div>
        {edit && (
          <div className="space-y-6">
            <Card><CardHeader title="Upload" /><CardBody><Uploader wsId={ws.workspaceId} projects={projects.map((p) => ({ id: p.id, title: p.title }))} ideaId={sp.idea} maxMb={ws.settings.limits.maxUploadMb} /></CardBody></Card>
            <Card><CardHeader title="Projects" description="Group recordings for one video." /><CardBody>
              <ActionForm action={createProjectAction} resetOnSuccess className="space-y-2">{hidden}<input type="hidden" name="ideaId" value={sp.idea ?? ""} />
                <Input name="title" placeholder="Project name" aria-label="Project name" required /><Input name="recordingDate" type="date" aria-label="Recording date" /><SubmitButton size="sm" variant="secondary">Create project</SubmitButton>
              </ActionForm>
            </CardBody></Card>
          </div>
        )}
      </div>
    </>
  );
}
