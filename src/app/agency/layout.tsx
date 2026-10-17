import { redirect } from "next/navigation";
import { AppShell, type NavSection } from "@/components/shell";
import { pageActor } from "@/server/auth";
import { agencyOverview } from "@/server/services/workspaces";
import { accessibleWorkspaces, primaryOrg } from "@/server/tenancy";

export const dynamic = "force-dynamic";

export default async function AgencyLayout({ children }: { children: React.ReactNode }) {
  const actor = await pageActor();
  const org = await primaryOrg(actor);
  if (!org?.isAdmin) redirect("/");
  const [wss, stats] = await Promise.all([accessibleWorkspaces(actor), agencyOverview(org.orgId)]);
  const sections: NavSection[] = [
    { items: [{ href: "/agency", label: "Overview", icon: "grid", exact: true }, { href: "/agency/clients", label: "Clients", icon: "users" }] },
    { title: "Agents", items: [
      { href: "/agency/templates", label: "Agent templates", icon: "layers" },
      { href: "/agency/blueprints", label: "Blueprint library", icon: "package" },
      { href: "/agency/deploy", label: "Deploy", icon: "rocket" },
    ] },
    { title: "Operations", items: [
      { href: "/agency/runs", label: "Workflow runs", icon: "activity", badge: stats.failedJobs },
      { href: "/agency/integrations", label: "Integrations", icon: "plug" },
      { href: "/agency/audit", label: "Audit log", icon: "history" },
      { href: "/agency/settings", label: "Settings", icon: "settings" },
    ] },
  ];
  return (
    <AppShell user={{ name: actor.name, email: actor.email }} sections={sections} isAgency workspaces={wss.map(({ ws, role }) => ({ id: ws.id, name: ws.name, role }))} crumb={org.orgName}>
      {children}
    </AppShell>
  );
}
