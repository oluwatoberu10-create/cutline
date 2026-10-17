import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Badge, Card, PageHeader } from "@/components/ui/kit";
import { cn } from "@/lib/utils";
import { scheduleIdeaAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { calendarMonth, listIdeas } from "@/server/services/ideas";
import { can } from "@/server/tenancy";

export const metadata = { title: "Calendar" };

export default async function Calendar({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ m?: string }> }) {
  const ws = await pageWs((await params).ws);
  const { m } = await searchParams;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ws.timezone }).format(new Date());
  const month = m && /^\d{4}-\d{2}$/.test(m) ? m : today.slice(0, 7);
  const [y, mo] = month.split("-").map(Number);
  const entries = await calendarMonth(ws, month);
  const unscheduled = (await listIdeas(ws, { status: "approved" })).filter((i) => !entries.some((e) => e.idea.id === i.id));
  const first = new Date(Date.UTC(y, mo - 1, 1));
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const shift = (d: number) => { const t = new Date(Date.UTC(y, mo - 1 + d, 1)); return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`; };
  const edit = can(ws.role, "edit");
  return (
    <>
      <PageHeader title="Content calendar" description="Approved ideas with their planned publication dates (in the workspace timezone)."
        actions={<div className="flex items-center gap-2 text-[13px]"><Link href={`?m=${shift(-1)}`} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5">←</Link><span className="w-32 text-center font-semibold">{first.toLocaleString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}</span><Link href={`?m=${shift(1)}`} className="rounded-lg border border-[var(--border)] px-2.5 py-1.5">→</Link></div>} />
      <div className="grid gap-6 xl:grid-cols-[1fr_300px]">
        <Card className="overflow-hidden">
          <div className="grid grid-cols-7 border-b border-[var(--border)] text-center text-[11px] font-semibold uppercase tracking-wide text-[var(--text-subtle)]">{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="py-2">{d}</div>)}</div>
          <div className="grid grid-cols-7">
            {Array.from({ length: lead }).map((_, i) => <div key={`l${i}`} className="min-h-24 border-b border-r border-[var(--border)] bg-[var(--surface-2)]/40" />)}
            {Array.from({ length: days }, (_, i) => {
              const date = `${month}-${String(i + 1).padStart(2, "0")}`;
              const items = entries.filter((e) => e.entry.publishDate === date);
              return (
                <div key={date} className={cn("min-h-24 border-b border-r border-[var(--border)] p-1.5", date === today && "bg-[var(--brand-soft)]/50")}>
                  <div className={cn("text-[11.5px] font-semibold", date === today ? "text-[var(--brand)]" : "text-[var(--text-subtle)]")}>{i + 1}</div>
                  {items.map(({ idea }) => <Link key={idea.id} href={`/w/${ws.workspaceId}/ideas?status=${idea.status}`} className="mt-1 block truncate rounded bg-[var(--brand)] px-1.5 py-0.5 text-[11.5px] font-medium text-[var(--on-brand)]" title={idea.title}>{idea.title}</Link>)}
                </div>
              );
            })}
          </div>
        </Card>
        <Card className="h-fit p-4">
          <div className="text-[14px] font-semibold">Approved, not scheduled</div>
          <ul className="mt-3 space-y-3">
            {unscheduled.length === 0 && <li className="text-[13px] text-[var(--text-muted)]">Nothing waiting.</li>}
            {unscheduled.map((i) => (
              <li key={i.id} className="space-y-1.5">
                <div className="text-[13px] font-medium">{i.title} <Badge>{i.priorityScore}</Badge></div>
                {edit && <ActionForm action={scheduleIdeaAction} className="flex gap-2"><input type="hidden" name="ws" value={ws.workspaceId} /><input type="hidden" name="id" value={i.id} /><input type="date" name="date" required aria-label="Date" className="h-8 flex-1 rounded-[var(--radius-field)] border border-[var(--border)] bg-[var(--surface)] px-2 text-[13px]" /><SubmitButton size="sm" variant="secondary">Add</SubmitButton></ActionForm>}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
