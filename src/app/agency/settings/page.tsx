import { eq } from "drizzle-orm";
import { db } from "@/db";
import { orgMemberships, organizations, users } from "@/db/schema";
import { RevealData } from "@/components/forms";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, PageHeader } from "@/components/ui/kit";
import { parseOrgSettings } from "@/lib/settings";
import { inviteAgencyMemberAction, saveOrgSettingsAction } from "@/server/actions/agency";
import { pageOrg } from "@/server/page-ctx";

export const metadata = { title: "Agency settings" };

export default async function Settings() {
  const org = await pageOrg();
  const [row] = await db.select().from(organizations).where(eq(organizations.id, org.orgId));
  const s = parseOrgSettings(row.settings);
  const members = await db.select({ u: users, role: orgMemberships.role }).from(orgMemberships).innerJoin(users, eq(users.id, orgMemberships.userId)).where(eq(orgMemberships.orgId, org.orgId));
  return (
    <>
      <PageHeader title="Agency settings" description="Preferences, default processing limits for new clients, access control and security." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Preferences & default limits" />
          <CardBody>
            <ActionForm action={saveOrgSettingsAction} className="grid gap-4 sm:grid-cols-2">
              <Field label="Agency name" htmlFor="name"><Input id="name" name="name" defaultValue={row.name} /></Field>
              <Field label="Default timezone" htmlFor="tz"><Input id="tz" name="defaultTimezone" defaultValue={s.defaultTimezone} /></Field>
              <Field label="Max upload (MB)" htmlFor="mu"><Input id="mu" name="maxUploadMb" type="number" defaultValue={s.defaultLimits.maxUploadMb} /></Field>
              <Field label="Render minutes / month" htmlFor="rm"><Input id="rm" name="monthlyRenderMinutes" type="number" defaultValue={s.defaultLimits.monthlyRenderMinutes} /></Field>
              <Field label="Transcription minutes / month" htmlFor="tm"><Input id="tm" name="monthlyTranscriptionMinutes" type="number" defaultValue={s.defaultLimits.monthlyTranscriptionMinutes} /></Field>
              <Field label="LLM calls / month" htmlFor="lc"><Input id="lc" name="monthlyLlmCalls" type="number" defaultValue={s.defaultLimits.monthlyLlmCalls} /></Field>
              <Field label="Session length (days)" htmlFor="sd"><Input id="sd" name="sessionDays" type="number" defaultValue={s.security.sessionDays} /></Field>
              <div className="sm:col-span-2"><SubmitButton>Save</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Agency team" description="Admins manage every client, template and deployment. Members only see workspaces they are invited to." />
          <ul className="divide-y divide-[var(--border)]">{members.map(({ u, role }) => (
            <li key={u.id} className="flex items-center gap-3 px-5 py-2.5"><div className="flex-1"><div className="text-[13.5px] font-medium">{u.name}</div><div className="text-[12px] text-[var(--text-muted)]">{u.email}</div></div><Badge tone={role === "admin" ? "brand" : "neutral"}>{role}</Badge></li>
          ))}</ul>
          <CardBody className="border-t border-[var(--border)]">
            <ActionForm action={inviteAgencyMemberAction} resetOnSuccess className="flex flex-wrap items-end gap-2">
              <Field label="Invite by email" htmlFor="em" className="min-w-52 flex-1"><Input id="em" name="email" type="email" required /></Field>
              <Field label="Role" htmlFor="rl"><Select id="rl" name="role"><option value="member">Member</option><option value="admin">Admin</option></Select></Field>
              <SubmitButton>Create invite</SubmitButton>
              <div className="w-full"><RevealData field="link" label="Invite link (share it directly — no email is sent)" prefixOrigin /></div>
            </ActionForm>
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Security" />
          <CardBody className="grid gap-3 text-[13px] text-[var(--text-muted)] sm:grid-cols-2">
            <div>• OAuth tokens, API keys and upload sessions are encrypted with AES-256-GCM (CUTLINE_ENCRYPTION_KEY) and never sent to the browser.</div>
            <div>• Every workspace action is authorised on the server; members of one client cannot see another client’s workspace.</div>
            <div>• Media is served through short-lived signed URLs bound to its workspace.</div>
            <div>• Publishing always requires an explicit approval, unless a workspace owner authorises rule-based publishing (audit-logged, revocable).</div>
            <div>• Blueprint exports are scanned for credentials and private data; a finding blocks the export.</div>
            <div>• Sign-in and API calls are rate-limited; every significant action is recorded in the audit log.</div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
