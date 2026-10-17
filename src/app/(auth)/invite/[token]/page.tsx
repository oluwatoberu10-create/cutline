import { AuthCard } from "@/components/auth-card";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/kit";
import { acceptInviteAction } from "@/server/actions/auth";
import { getActor } from "@/server/auth";
import { inviteByToken } from "@/server/services/workspaces";

export const metadata = { title: "Accept invite" };
export const dynamic = "force-dynamic";

export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const inv = await inviteByToken(token);
  const actor = await getActor();
  if (!inv) return <AuthCard title="Invite not valid"><Notice tone="warning">This link is invalid, already used or expired. Ask for a new invite.</Notice></AuthCard>;
  return (
    <AuthCard title={inv.workspaceId ? "Join a client workspace" : "Join the agency"} subtitle={<>Invite for <strong>{inv.email}</strong></>}>
      <ActionForm action={acceptInviteAction} className="space-y-4">
        <input type="hidden" name="token" value={token} />
        {actor ? (
          <Notice tone="info">You are signed in as {actor.email}. {actor.email.toLowerCase() !== inv.email ? "This invite is for a different address — sign out first." : "Accepting adds access to your account."}</Notice>
        ) : (
          <>
            <Field label="Your name" htmlFor="name"><Input id="name" name="name" required autoFocus /></Field>
            <Field label="Choose a password" htmlFor="password" hint="At least 10 characters."><Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
          </>
        )}
        <SubmitButton className="w-full" pendingLabel="Joining…">Accept invite</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
