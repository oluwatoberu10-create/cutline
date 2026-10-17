import Link from "next/link";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge } from "@/components/ui/kit";
import { archiveClientAction, createClientAction } from "@/server/actions/agency";
import { pageOrg } from "@/server/page-ctx";
import { listWorkspaces } from "@/server/services/workspaces";

export const metadata = { title: "Clients" };

export default async function Clients({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; new?: string; deleted?: string }> }) {
  const org = await pageOrg();
  const sp = await searchParams;
  const status = sp.status === "archived" ? "archived" : "active";
  const rows = await listWorkspaces(org.orgId, { q: sp.q?.slice(0, 80), status });
  return (
    <>
      <PageHeader title="Clients" description="Each client has an isolated workspace: their own accounts, footage, analytics, agent configuration and job history." />
      {sp.deleted && <div className="mb-5"><Notice tone="success">Deletion scheduled. Files are being removed by the worker; the workspace disappears when it finishes.</Notice></div>}
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-4 py-3">
            <form className="flex flex-1 gap-2" role="search">
              <input type="hidden" name="status" value={status} />
              <Input name="q" defaultValue={sp.q} placeholder="Search clients by name or email" className="h-9 max-w-xs" aria-label="Search clients" />
            </form>
            <Link href={`?status=active`} className={`text-[13px] font-medium ${status === "active" ? "text-[var(--text)]" : "text-[var(--text-muted)]"}`}>Active</Link>
            <Link href={`?status=archived`} className={`text-[13px] font-medium ${status === "archived" ? "text-[var(--text)]" : "text-[var(--text-muted)]"}`}>Archived</Link>
          </div>
          {rows.length === 0 ? <EmptyState icon="users" title={sp.q ? "No matching clients" : status === "archived" ? "No archived clients" : "No clients yet"} description="Create a client workspace to start." /> : (
            <div className="table-wrap"><table className="table-cl">
              <thead><tr><th>Client</th><th>Agent</th><th>Recordings</th><th>Approvals</th><th>Failed (7d)</th><th /></tr></thead>
              <tbody>{rows.map(({ ws, deploymentStatus, pendingApprovals, failedJobs, assets }) => (
                <tr key={ws.id}>
                  <td><Link href={`/w/${ws.id}`} className="font-medium hover:text-[var(--brand)]">{ws.name}</Link><div className="text-[12px] text-[var(--text-muted)]">{ws.contactEmail ?? "—"} {ws.ownershipMode === "client_owned" && <Badge tone="info" className="ml-1">client-owned</Badge>}</div></td>
                  <td>{deploymentStatus ? <StatusBadge status={deploymentStatus} /> : <Link href={`/agency/deploy?ws=${ws.id}`} className="text-[13px] text-[var(--brand)]">Deploy</Link>}</td>
                  <td className="tnum">{assets}</td>
                  <td className="tnum">{pendingApprovals ? <Badge tone="warning">{pendingApprovals}</Badge> : 0}</td>
                  <td className="tnum">{failedJobs ? <Badge tone="danger">{failedJobs}</Badge> : 0}</td>
                  <td className="text-right">
                    <ActionForm action={archiveClientAction} showErrorBanner={false}>
                      <input type="hidden" name="ws" value={ws.id} /><input type="hidden" name="archive" value={String(status === "active")} />
                      <ConfirmSubmit variant="ghost" danger={status === "active"} title={status === "active" ? `Archive ${ws.name}?` : `Restore ${ws.name}?`} description={status === "active" ? "The agent is paused and the workspace becomes read-only. Data is kept." : "The workspace becomes editable again; reactivate its agent from the Agent page."} confirmLabel={status === "active" ? "Archive" : "Restore"}>{status === "active" ? "Archive" : "Restore"}</ConfirmSubmit>
                    </ActionForm>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card id="new">
          <CardHeader title="New client" description="Creates an empty, isolated workspace." />
          <CardBody>
            <ActionForm action={createClientAction} className="space-y-4">
              <Field label="Client or channel name" htmlFor="name" required><Input id="name" name="name" required autoFocus={Boolean(sp.new)} /></Field>
              <Field label="Contact email" htmlFor="contactEmail" hint="For your records; no email is sent."><Input id="contactEmail" name="contactEmail" type="email" /></Field>
              <Field label="Timezone" htmlFor="timezone" hint="Used for scheduling and the calendar."><Input id="timezone" name="timezone" defaultValue="UTC" placeholder="Europe/London" /></Field>
              <Field label="Operating arrangement" htmlFor="ownershipMode">
                <Select id="ownershipMode" name="ownershipMode" defaultValue="agency_managed"><option value="agency_managed">Agency-managed (hosted here)</option><option value="client_owned">Client-owned (they run their own install)</option></Select>
              </Field>
              <div className="flex flex-wrap gap-2">
                <SubmitButton name="then" value="open">Create</SubmitButton>
                <SubmitButton name="then" value="deploy" variant="secondary">Create & deploy agent</SubmitButton>
              </div>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
