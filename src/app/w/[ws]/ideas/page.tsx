import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, CardBody, EmptyState, MockBadge, PageHeader, StatusBadge } from "@/components/ui/kit";
import { editIdeaAction, ideaStatusAction, queueJobAction, scheduleIdeaAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { channelVideos } from "@/server/services/channel";
import { ideaFacets, ideaFilters, listIdeas } from "@/server/services/ideas";
import { can } from "@/server/tenancy";
import { db } from "@/db";
import { calendarEntries } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Content ideas" };

export default async function Ideas({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string>> }) {
  const ws = await pageWs((await params).ws);
  const raw = await searchParams;
  const f = ideaFilters.safeParse(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)));
  const filters = f.success ? f.data : {};
  const [ideas, facets, vids, cal] = await Promise.all([listIdeas(ws, filters), ideaFacets(ws), channelVideos(ws, 500), db.select().from(calendarEntries).where(eq(calendarEntries.workspaceId, ws.workspaceId))]);
  const titleOf = new Map(vids.map((v) => [v.youtubeVideoId, v.title]));
  const dateOf = new Map(cal.map((c) => [c.ideaId, c.publishDate]));
  const edit = can(ws.role, "edit");
  const hidden = <input type="hidden" name="ws" value={ws.workspaceId} />;

  return (
    <>
      <PageHeader title="Content ideas" description="Grounded in this channel's data and the creator's saved feedback. Approve ideas to schedule them; rejections with a reason teach the agent what to avoid — for this creator only." />
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          <Card><CardBody>
            <form className="grid gap-3 sm:grid-cols-5">
              <Select name="status" defaultValue={filters.status ?? ""} aria-label="Status"><option value="">Open (not rejected)</option>{["proposed", "saved", "approved", "in_production", "published", "rejected", "archived"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</Select>
              <Select name="topic" defaultValue={filters.topic ?? ""} aria-label="Topic"><option value="">Any topic</option>{facets.topics.map((t) => <option key={t}>{t}</option>)}</Select>
              <Select name="format" defaultValue={filters.format ?? ""} aria-label="Format"><option value="">Any format</option>{facets.formats.map((t) => <option key={t}>{t}</option>)}</Select>
              <Input name="audience" defaultValue={filters.audience ?? ""} placeholder="Audience contains…" aria-label="Audience" />
              <div className="flex gap-2"><Input name="minPriority" type="number" min={0} max={100} defaultValue={filters.minPriority ?? ""} placeholder="Min priority" aria-label="Minimum priority" /><button className="rounded-[var(--radius-field)] border border-[var(--border)] px-3 text-[13px] font-medium">Filter</button></div>
            </form>
          </CardBody></Card>

          {ideas.length === 0 ? <Card><EmptyState icon="lightbulb" title="No ideas match" description="Generate a batch, or relax the filters." /></Card> : ideas.map((i) => (
            <Card key={i.id} className="overflow-hidden">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-start gap-4 px-5 py-4 hover:bg-[var(--surface-2)]">
                  <div className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[var(--brand)]" title={i.priorityReason}><span className="tnum text-[15px] font-bold leading-none">{i.priorityScore}</span><span className="text-[9px] font-semibold uppercase">priority</span></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{i.title}</span><StatusBadge status={i.status} />{i.isMock && <MockBadge />}{dateOf.get(i.id) && <Badge tone="brand">{dateOf.get(i.id)}</Badge>}</div>
                    <p className="mt-1 line-clamp-2 text-[13px] text-[var(--text-muted)]">{i.concept}</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11.5px]">{i.topic && <Badge>{i.topic}</Badge>}{i.format && <Badge>{i.format}</Badge>}{i.lengthMinutes != null && <Badge>{i.lengthMinutes} min</Badge>}{i.targetAudience && <Badge>{i.targetAudience}</Badge>}</div>
                  </div>
                </summary>
                <div className="grid gap-5 border-t border-[var(--border)] px-5 py-4 md:grid-cols-2">
                  <div className="space-y-3 text-[13px]">
                    <Detail label="Why it fits">{i.fitReason}</Detail>
                    <Detail label="Audience need">{i.audienceNeed}</Detail>
                    <Detail label="Opening hook">{i.hook}</Detail>
                    <Detail label="Outline"><ol className="list-decimal pl-4">{(i.outline as string[]).map((o, k) => <li key={k}>{o}</li>)}</ol></Detail>
                    <Detail label="Search phrases">{i.keywords.join(", ") || "—"}</Detail>
                    <Detail label="Short-form opportunities">{i.shortsOpportunities.join(" · ") || "—"}</Detail>
                    <Detail label="Supporting videos">{i.supportingVideoIds.length ? i.supportingVideoIds.map((v) => titleOf.get(v) ?? v).join(" · ") : "None cited"}</Detail>
                    <Detail label="Priority reasoning">{i.priorityReason}</Detail>
                    <Detail label="Evidence notes">{i.evidenceNotes}</Detail>
                    <p className="text-[11.5px] text-[var(--text-subtle)]">Generated by {i.provider}/{i.model}</p>
                  </div>
                  {edit && (
                    <div className="space-y-4">
                      <div className="flex flex-wrap gap-2">
                        {(["saved", "approved"] as const).filter((s) => s !== i.status).map((s) => (
                          <ActionForm key={s} action={ideaStatusAction} showErrorBanner={false}>{hidden}<input type="hidden" name="id" value={i.id} /><input type="hidden" name="status" value={s} /><SubmitButton size="sm" variant={s === "approved" ? "primary" : "secondary"}>{s === "saved" ? "Save" : "Approve"}</SubmitButton></ActionForm>
                        ))}
                        {i.status !== "archived" && <ActionForm action={ideaStatusAction} showErrorBanner={false}>{hidden}<input type="hidden" name="id" value={i.id} /><input type="hidden" name="status" value="archived" /><SubmitButton size="sm" variant="ghost">Archive</SubmitButton></ActionForm>}
                      </div>
                      <ActionForm action={ideaStatusAction} className="space-y-2">
                        {hidden}<input type="hidden" name="id" value={i.id} />
                        <Input name="reason" placeholder="Reason (teaches the agent for this creator)" aria-label="Reason" />
                        <div className="flex gap-2"><SubmitButton size="sm" variant="secondary" name="status" value="rejected">Reject</SubmitButton><SubmitButton size="sm" variant="outline" name="status" value="regenerate">Reject & regenerate</SubmitButton></div>
                      </ActionForm>
                      {(i.status === "approved" || i.status === "in_production") && (
                        <ActionForm action={scheduleIdeaAction} className="flex items-end gap-2">{hidden}<input type="hidden" name="id" value={i.id} />
                          <Field label="Publication date" htmlFor={`d-${i.id}`}><Input id={`d-${i.id}`} name="date" type="date" defaultValue={dateOf.get(i.id) ?? ""} /></Field><SubmitButton size="sm" variant="secondary">{dateOf.get(i.id) ? "Update" : "Schedule"}</SubmitButton>
                        </ActionForm>
                      )}
                      <details className="rounded-[var(--radius-field)] border border-[var(--border)] p-3">
                        <summary className="cursor-pointer text-[13px] font-medium">Edit idea</summary>
                        <ActionForm action={editIdeaAction} className="mt-3 grid gap-2">
                          {hidden}<input type="hidden" name="id" value={i.id} />
                          <Input name="title" defaultValue={i.title} aria-label="Title" />
                          <Textarea name="concept" defaultValue={i.concept} rows={3} aria-label="Concept" />
                          <Input name="hook" defaultValue={i.hook} aria-label="Hook" />
                          <div className="grid grid-cols-3 gap-2"><Input name="topic" defaultValue={i.topic} aria-label="Topic" placeholder="Topic" /><Input name="format" defaultValue={i.format} aria-label="Format" placeholder="Format" /><Input name="lengthMinutes" type="number" defaultValue={i.lengthMinutes ?? ""} aria-label="Minutes" placeholder="Minutes" /></div>
                          <Input name="targetAudience" defaultValue={i.targetAudience} aria-label="Audience" />
                          <Textarea name="outline" defaultValue={(i.outline as string[]).join("\n")} rows={4} aria-label="Outline (one per line)" />
                          <Input name="keywords" defaultValue={i.keywords.join(", ")} aria-label="Keywords" />
                          <Input name="priorityScore" type="number" min={0} max={100} defaultValue={i.priorityScore} aria-label="Priority" />
                          <SubmitButton size="sm">Save changes</SubmitButton>
                        </ActionForm>
                      </details>
                      <Link className="block text-[13px] font-medium text-[var(--brand)]" href={`/w/${ws.workspaceId}/media?idea=${i.id}`}>Upload footage for this idea →</Link>
                    </div>
                  )}
                </div>
              </details>
            </Card>
          ))}
        </div>
        {edit && (
          <Card className="h-fit">
            <CardBody>
              <div className="text-[14px] font-semibold">Generate ideas</div>
              <p className="mt-1 text-[12.5px] text-[var(--text-muted)]">Uses the latest channel analysis, the creator profile and saved feedback. Runs in the background.</p>
              <ActionForm action={queueJobAction} className="mt-3 space-y-3">{hidden}<input type="hidden" name="type" value="ideas.generate" />
                <Field label="How many" htmlFor="count"><Input id="count" name="count" type="number" min={1} max={30} placeholder="Agent default" /></Field>
                <Field label="Focus (optional)" htmlFor="focus"><Textarea id="focus" name="focus" rows={2} placeholder="e.g. beginner questions, a new series" /></Field>
                <SubmitButton>Generate</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[var(--text-subtle)]">{label}</div><div className="mt-0.5">{children || "—"}</div></div>;
}
