import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input } from "@/components/ui/field";
import { loginAction } from "@/server/actions/auth";
import { getActor } from "@/server/auth";
import { needsSetup } from "@/server/services/workspaces";

export const metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await needsSetup()) redirect("/setup");
  if (await getActor()) redirect("/");
  const { next } = await searchParams;
  return (
    <AuthCard title="Sign in" subtitle="Agency staff and creators sign in here.">
      <ActionForm action={loginAction} className="space-y-4">
        <input type="hidden" name="next" value={next ?? "/"} />
        <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required autoFocus /></Field>
        <Field label="Password" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
        <SubmitButton className="w-full" pendingLabel="Signing in…">Sign in</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
