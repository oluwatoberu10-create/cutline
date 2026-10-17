import { redirect } from "next/navigation";
import { getActor } from "@/server/auth";
import { needsSetup } from "@/server/services/workspaces";
import { accessibleWorkspaces } from "@/server/tenancy";

export const dynamic = "force-dynamic";

/** Sends each person to the right place: setup, sign-in, the agency dashboard, or their workspace. */
export default async function Home() {
  if (await needsSetup()) redirect("/setup");
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (actor.orgs.some((o) => o.role === "admin")) redirect("/agency");
  const ws = await accessibleWorkspaces(actor);
  if (ws.length) redirect(`/w/${ws[0].ws.id}`);
  redirect("/account?nowork=1");
}
