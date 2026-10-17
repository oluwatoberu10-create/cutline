import { count, and, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvalRequests } from "@/db/schema";
import { AppShell, type NavSection } from "@/components/shell";
import { Notice } from "@/components/ui/kit";
import { pageActor } from "@/server/auth";
import { pageWs } from "@/server/page-ctx";
import { accessibleWorkspaces, can } from "@/server/tenancy";

export const dynamic = "force-dynamic";

export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ ws: string }> }) {
  const { ws: id } = await params;
  const actor = await pageActor();
  const ws = await pageWs(id);
  const [wss, [pending]] = await Promise.all([
    accessibleWorkspaces(actor),
    db.select({ n: count() }).from(approvalRequests).where(and(eq(approvalRequests.workspaceId, ws.workspaceId), eq(approvalRequests.status, "pending"))),
  ]);
  const b = `/w/${ws.workspaceId}`;
  const sections: NavSection[] = [
    { items: [{ href: b, label: "Overview", icon: "home", exact: true }, { href: `${b}/approvals`, label: "Approvals", icon: "checkCircle", badge: Number(pending.n) }] },
    { title: "Plan", items: [
      { href: `${b}/channel`, label: "Channel insights", icon: "chart" },
      { href: `${b}/ideas`, label: "Content ideas", icon: "lightbulb" },
      { href: `${b}/calendar`, label: "Calendar", icon: "calendar" },
    ] },
    { title: "Produce", items: [
      { href: `${b}/media`, label: "Media library", icon: "film" },
      { href: `${b}/edits`, label: "Edits", icon: "scissors" },
      { href: `${b}/publishing`, label: "Publishing", icon: "upload" },
    ] },
    { title: "Agent", items: [
      { href: `${b}/agent`, label: "Agent", icon: "rocket" },
      { href: `${b}/runs`, label: "Workflow runs", icon: "activity" },
      { href: `${b}/integrations`, label: "Integrations", icon: "plug" },
      { href: `${b}/profile`, label: "Creator profile", icon: "team" },
      ...(can(ws.role, "approve") ? [{ href: `${b}/settings`, label: "Settings", icon: "settings" as const }] : []),
    ] },
  ];
  return (
    <AppShell user={{ name: actor.name, email: actor.email }} sections={sections} isAgency={actor.orgs.some((o) => o.role === "admin")}
      workspaces={wss.map(({ ws: w, role }) => ({ id: w.id, name: w.name, role }))} currentWorkspace={ws.workspaceId}
      crumb={<><span className="font-medium text-[var(--text)]">{ws.workspaceName}</span> · {ws.role.replace("_", " ")}</>}>
      {ws.status === "archived" && <div className="mb-5"><Notice tone="warning" title="Archived workspace">Read-only. An agency admin can restore it from Clients.</Notice></div>}
      {children}
    </AppShell>
  );
}
