import { redirect } from "next/navigation";
import { AuthCard } from "@/components/auth-card";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input } from "@/components/ui/field";
import { setupAction } from "@/server/actions/auth";
import { needsSetup } from "@/server/services/workspaces";

export const metadata = { title: "Set up" };
export const dynamic = "force-dynamic";

/** First run only: once any user exists this page redirects away. */
export default async function Setup() {
  if (!(await needsSetup())) redirect("/login");
  return (
    <AuthCard title="Set up your installation" subtitle="Create the agency (or your own channel business) and its first administrator. This page disappears once it is done.">
      <ActionForm action={setupAction} className="space-y-4">
        <Field label="Agency or business name" htmlFor="orgName"><Input id="orgName" name="orgName" required autoFocus /></Field>
        <Field label="Your name" htmlFor="name"><Input id="name" name="name" autoComplete="name" required /></Field>
        <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Password" htmlFor="password" hint="At least 10 characters."><Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
        <SubmitButton className="w-full" pendingLabel="Creating…">Create administrator</SubmitButton>
      </ActionForm>
    </AuthCard>
  );
}
