import Link from "next/link";
import { allRoutes } from "@/server/api/registry";
import "@/server/api/routes";
import { Badge, Card, PageHeader } from "@/components/ui/kit";
import { pageActor } from "@/server/auth";

export const metadata = { title: "API reference" };
export const dynamic = "force-dynamic";

const METHOD_TONE = { GET: "info", POST: "success", PUT: "warning", PATCH: "warning", DELETE: "danger" } as const;

/** Generated from the same route registry that serves the API. */
export default async function ApiDocs() {
  await pageActor();
  const routes = allRoutes();
  const tags = [...new Set(routes.map((r) => r.tag))];
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <PageHeader title="API reference" back={{ href: "/", label: "Back" }}
        description={<>Base URL <code className="mono">/api/v1</code>. Authenticate with <code className="mono">Authorization: Bearer &lt;token&gt;</code> (create one under <Link href="/account" className="text-[var(--brand)] underline">Account</Link>) or a session cookie. Every response is <code className="mono">{"{ success, data | error }"}</code>. Machine-readable spec: <a className="text-[var(--brand)] underline" href="/api/v1/openapi.json">openapi.json</a>.</>} />
      <div className="space-y-6">
        {tags.map((tag) => (
          <Card key={tag} className="overflow-hidden">
            <div className="border-b border-[var(--border)] px-5 py-3 text-[14px] font-semibold">{tag}</div>
            <ul className="divide-y divide-[var(--border)]">
              {routes.filter((r) => r.tag === tag).map((r) => (
                <li key={r.method + r.path} className="flex flex-wrap items-center gap-3 px-5 py-2.5">
                  <Badge tone={METHOD_TONE[r.method]} className="mono w-16 justify-center">{r.method}</Badge>
                  <code className="mono text-[13px]">{r.path}</code>
                  <span className="flex-1 text-[13px] text-[var(--text-muted)]">{r.summary}</span>
                  <span className="text-[11.5px] text-[var(--text-subtle)]">{r.access === "agency" ? "agency admin" : r.access === "user" ? "any user" : `workspace: ${r.access.workspace}`}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
