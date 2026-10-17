import { RevealData } from "@/components/forms";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Checkbox, Field, Input, Select } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui/kit";
import { autoPublishAction, deleteWorkspaceAction, inviteMemberAction, memberRoleAction, workspaceSettingsAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { workspaceMembers } from "@/server/services/workspaces";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { eq } from "drizzle-orm";

export const metadata = { title: "Workspace settings" };

export default async function WsSettings({ params }: { params: Promise<{ ws: string }> }) {
  const ws = await pageWs((await params).ws, "approve");
  const [members, [row]] = await Promise.all([workspaceMembers(ws), db.select().from(workspaces).where(eq(workspaces.id, ws.workspaceId))]);
  const agency = ws.role === "agency_admin";
  const s = ws.settings;
  const h = <input type="hidden" name="ws" value={ws.workspaceId} />;
  return (
    <>
      <PageHeader title="Workspace settings" description="Access, processing limits, data retention and publishing authorisation for this client." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Details, limits & retention" />
          <CardBody>
            <ActionForm action={workspaceSettingsAction} className="grid gap-4 sm:grid-cols-2">{h}
              <Field label="Name" htmlFor="n"><Input id="n" name="name" defaultValue={ws.workspaceName} /></Field>
              <Field label="Contact email" htmlFor="ce"><Input id="ce" name="contactEmail" type="email" defaultValue={row.contactEmail ?? ""} /></Field>
              <Field label="Timezone" htmlFor="tz"><Input id="tz" name="timezone" defaultValue={ws.timezone} /></Field>
              <div />
              <fieldset disabled={!agency} className="contents">
                <Field label="Max upload (MB)" htmlFor="mu"><Input id="mu" name="maxUploadMb" type="number" defaultValue={s.limits.maxUploadMb} /></Field>
                <Field label="Render minutes / month" htmlFor="rm"><Input id="rm" name="monthlyRenderMinutes" type="number" defaultValue={s.limits.monthlyRenderMinutes} /></Field>
                <Field label="Transcription minutes / month" htmlFor="tm"><Input id="tm" name="monthlyTranscriptionMinutes" type="number" defaultValue={s.limits.monthlyTranscriptionMinutes} /></Field>
                <Field label="LLM calls / month" htmlFor="lc"><Input id="lc" name="monthlyLlmCalls" type="number" defaultValue={s.limits.monthlyLlmCalls} /></Field>
                <div className="sm:col-span-2"><Checkbox name="allowAgencyProviders" defaultChecked={s.allowAgencyProviders} label="Allow agency-shared AI providers" hint="When off, only this client's own keys are used." /></div>
              </fieldset>
              <Field label="Delete renders after (days, 0 = keep)" htmlFor="rd"><Input id="rd" name="renderDays" type="number" min={0} defaultValue={s.retention.renderDays} /></Field>
              <Field label="Delete original footage after (days, 0 = keep)" htmlFor="sd"><Input id="sd" name="sourceDays" type="number" min={0} defaultValue={s.retention.sourceDays} /></Field>
              <div className="sm:col-span-2"><SubmitButton>Save</SubmitButton>{!agency && <span className="ml-3 text-[12px] text-[var(--text-muted)]">Limits are managed by the agency.</span>}</div>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Rule-based publishing authorisation" description="Rule-based mode may upload private or unlisted videos without per-video approval only while this is on. Public and scheduled videos always need approval." />
          <CardBody className="space-y-3">
            <div className="flex items-center gap-2 text-[13.5px]">Status: {s.autoPublishAuthorized ? <Badge tone="warning">Authorised</Badge> : <Badge>Not authorised</Badge>}</div>
            <ActionForm action={autoPublishAction}>{h}<input type="hidden" name="authorize" value={String(!s.autoPublishAuthorized)} />
              <ConfirmSubmit variant={s.autoPublishAuthorized ? "secondary" : "primary"} danger={s.autoPublishAuthorized} title={s.autoPublishAuthorized ? "Revoke authorisation?" : "Authorise rule-based publishing?"}
                description={s.autoPublishAuthorized ? "Every upload will need explicit approval again." : "The agent may upload approved-rule content as private/unlisted without asking each time. This is recorded in the audit log and can be revoked any time."}
                confirmLabel={s.autoPublishAuthorized ? "Revoke" : "Authorise"}>{s.autoPublishAuthorized ? "Revoke authorisation" : "Authorise"}</ConfirmSubmit>
            </ActionForm>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Members" description="Owner: approves edits and publishing, manages integrations. Editor: works on ideas, footage and edits. Viewer: read-only." />
          <ul className="divide-y divide-[var(--border)]">{members.length === 0 ? <li className="px-5 py-3 text-[13px] text-[var(--text-muted)]">No client members yet — agency admins have access.</li> : members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-2 px-5 py-2.5">
              <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{m.name}</div><div className="text-[12px] text-[var(--text-muted)]">{m.email}</div></div>
              <ActionForm action={memberRoleAction} className="flex items-center gap-1.5" showErrorBanner={false}>{h}<input type="hidden" name="userId" value={m.userId} />
                <Select name="role" defaultValue={m.role} className="h-8 w-28 text-[12.5px]" aria-label="Role"><option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option><option value="remove">Remove</option></Select>
                <SubmitButton size="sm" variant="secondary">Update</SubmitButton>
              </ActionForm>
            </li>
          ))}</ul>
          <CardBody className="border-t border-[var(--border)]">
            <ActionForm action={inviteMemberAction} resetOnSuccess className="flex flex-wrap items-end gap-2">{h}
              <Field label="Invite by email" htmlFor="em" className="min-w-48 flex-1"><Input id="em" name="email" type="email" required /></Field>
              <Field label="Role" htmlFor="rl"><Select id="rl" name="role" defaultValue="owner"><option value="owner">Owner (the creator)</option><option value="editor">Editor</option><option value="viewer">Viewer</option></Select></Field>
              <SubmitButton>Create invite</SubmitButton>
              <div className="w-full"><RevealData field="link" label="Invite link (no email is sent — share it directly)" prefixOrigin /></div>
            </ActionForm>
          </CardBody>
        </Card>

        {agency && (
          <Card>
            <CardHeader title="Delete this client's data" />
            <CardBody className="space-y-3">
              <Notice tone="danger">Permanently deletes every recording, render, transcript, idea, analytics snapshot, connection and credential of this workspace. Blueprints are not affected. This cannot be undone.</Notice>
              <ActionForm action={deleteWorkspaceAction} className="flex flex-wrap items-end gap-2">{h}
                <Field label={`Type “${ws.workspaceName}” to confirm`} htmlFor="cf" className="min-w-56 flex-1"><Input id="cf" name="confirm" autoComplete="off" /></Field>
                <ConfirmSubmit title="Delete everything?" description="Files are removed by the worker, then the workspace and all its records are deleted." confirmLabel="Delete permanently">Delete workspace</ConfirmSubmit>
              </ActionForm>
            </CardBody>
          </Card>
        )}
      </div>
    </>
  );
}
