import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { apiTokens } from "@/db/schema";
import { RevealData } from "@/components/forms";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select } from "@/components/ui/field";
import { Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, Timestamp } from "@/components/ui/kit";
import { changePasswordAction, createApiTokenAction, revokeApiTokenAction } from "@/server/actions/auth";
import { pageActor } from "@/server/auth";

export const metadata = { title: "Account" };
export const dynamic = "force-dynamic";

export default async function Account({ searchParams }: { searchParams: Promise<{ nowork?: string }> }) {
  const actor = await pageActor();
  const { nowork } = await searchParams;
  const tokens = await db.select().from(apiTokens).where(and(eq(apiTokens.userId, actor.userId), isNull(apiTokens.revokedAt))).orderBy(desc(apiTokens.createdAt));
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <PageHeader title="Your account" description={actor.email} back={{ href: "/", label: "Back" }} />
      {nowork && <div className="mb-5"><Notice tone="info">You do not have access to any workspace yet. Ask your agency or workspace owner for an invite.</Notice></div>}
      <div className="space-y-6">
        <Card>
          <CardHeader title="Password" />
          <CardBody>
            <ActionForm action={changePasswordAction} resetOnSuccess className="grid gap-4 sm:grid-cols-2">
              <Field label="Current password" htmlFor="current"><Input id="current" name="current" type="password" autoComplete="current-password" required /></Field>
              <Field label="New password" htmlFor="next" hint="At least 10 characters."><Input id="next" name="next" type="password" autoComplete="new-password" minLength={10} required /></Field>
              <div className="sm:col-span-2"><SubmitButton>Change password</SubmitButton></div>
            </ActionForm>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="API tokens" description={<>Personal tokens for the REST API (<Link className="text-[var(--brand)] underline" href="/docs/api">reference</Link>). A token acts with your permissions; only its hash is stored.</>} />
          <CardBody className="space-y-5">
            <ActionForm action={createApiTokenAction} resetOnSuccess className="flex flex-wrap items-end gap-3">
              <Field label="Name" htmlFor="tname" className="min-w-48 flex-1"><Input id="tname" name="name" placeholder="CI pipeline" required /></Field>
              <Field label="Expires" htmlFor="days"><Select id="days" name="days" defaultValue="90"><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="0">Never</option></Select></Field>
              <SubmitButton>Create token</SubmitButton>
              <div className="w-full"><RevealData field="token" label="Your new token — copy it now; it will not be shown again" /></div>
            </ActionForm>
            {tokens.length === 0 ? <EmptyState compact icon="terminal" title="No tokens" /> : (
              <div className="table-wrap"><table className="table-cl">
                <thead><tr><th>Name</th><th>Prefix</th><th>Last used</th><th>Expires</th><th /></tr></thead>
                <tbody>{tokens.map((t) => (
                  <tr key={t.id}><td className="font-medium">{t.name}</td><td className="mono">{t.prefix}…</td><td><Timestamp value={t.lastUsedAt} /></td><td><Timestamp value={t.expiresAt} /></td>
                    <td className="text-right"><ActionForm action={revokeApiTokenAction} showErrorBanner={false}><input type="hidden" name="id" value={t.id} /><ConfirmSubmit title="Revoke token?" description="Anything using it stops working immediately." confirmLabel="Revoke">Revoke</ConfirmSubmit></ActionForm></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
