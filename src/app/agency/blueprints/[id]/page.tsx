import Link from "next/link";
import { ButtonLink } from "@/components/ui/button";
import { Badge, Card, CardBody, CardHeader, EmptyState, KeyValue, Notice, PageHeader, StatusBadge, Tabs } from "@/components/ui/kit";
import { summarizeBlueprint } from "@/lib/blueprint/readme";
import { pageOrg } from "@/server/page-ctx";
import { deploymentsOfTemplate, exportPreview, listVersions, versionDiff } from "@/server/services/blueprints";

export const metadata = { title: "Blueprint version" };

export default async function BlueprintVersion({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; compare?: string; file?: string }> }) {
  const org = await pageOrg();
  const { id } = await params;
  const sp = await searchParams;
  const tab = sp.tab ?? "export";
  const p = await exportPreview(org, id);
  const bp = p.blueprint;
  const siblings = await listVersions(org, p.version.templateId);
  const deps = (await deploymentsOfTemplate(org, p.version.templateId)).filter((d) => d.d.blueprintVersionId === id);
  const compareTo = sp.compare && siblings.some((s) => s.id === sp.compare) ? sp.compare : siblings.find((s) => s.id !== id)?.id;
  const diff = tab === "diff" && compareTo ? await versionDiff(org, compareTo, id) : [];
  const fileShown = p.files.find((f) => f.path === (sp.file ?? "README.md"));
  return (
    <>
      <PageHeader eyebrow="Blueprint" title={`${bp.blueprint.name} v${bp.blueprint.version}`} description={summarizeBlueprint(bp)} back={{ href: "/agency/blueprints", label: "Blueprint library" }}
        actions={<><ButtonLink variant="secondary" href={`/agency/templates/${p.version.templateId}`}>Template</ButtonLink><ButtonLink href={`/agency/deploy?version=${id}`}>Deploy to a client</ButtonLink></>} />
      <Tabs active={tab} items={[{ key: "export", label: "Export preview", href: "?tab=export" }, { key: "diff", label: "Compare versions", href: "?tab=diff" }, { key: "deployments", label: "Deployments", href: "?tab=deployments", count: deps.length }]} />

      {tab === "export" && (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <Card><CardBody className="space-y-3">
              {p.blocked ? <Notice tone="danger" title="Export blocked">{p.findings.map((f) => <div key={f.file + f.path}>{f.file}: {f.rule}</div>)}</Notice> : <Notice tone="success">Secret scan passed on every file.</Notice>}
              <div className="flex flex-col gap-2">
                <a className="text-[13.5px] font-medium text-[var(--brand)]" href={`/api/v1/agency/blueprints/${id}/export?format=json`}>Download blueprint.json</a>
                <a className="text-[13.5px] font-medium text-[var(--brand)]" href={`/api/v1/agency/blueprints/${id}/export?format=zip`}>Download ZIP package</a>
                <a className="text-[13.5px] font-medium text-[var(--brand)]" href={`/api/v1/agency/blueprints/${id}/export?format=kit`}>Download client-owned deployment kit</a>
              </div>
            </CardBody></Card>
            <Card>
              <CardHeader title="Package contents" />
              <ul className="divide-y divide-[var(--border)] text-[13px]">
                {p.files.map((f) => (
                  <li key={f.path}><Link href={`?tab=export&file=${encodeURIComponent(f.path)}`} className={`flex justify-between px-5 py-2 hover:bg-[var(--surface-2)] ${fileShown?.path === f.path ? "font-semibold" : ""}`}><span className="mono truncate">{f.path}</span><span className="tnum text-[var(--text-subtle)]">{(f.bytes / 1024).toFixed(1)} KB</span></Link></li>
                ))}
              </ul>
            </Card>
            <Card><CardHeader title="Never included" /><CardBody><ul className="list-disc space-y-1 pl-4 text-[12.5px] text-[var(--text-muted)]">{p.excluded.map((e) => <li key={e}>{e}</li>)}</ul></CardBody></Card>
          </div>
          <Card className="min-w-0">
            <CardHeader title={<span className="mono">{fileShown?.path}</span>} />
            <CardBody>{fileShown?.preview != null ? <pre className="code-block max-h-[640px]">{fileShown.preview}</pre> : <pre className="code-block max-h-[640px]">{JSON.stringify(fileShown?.path === "blueprint.json" ? bp : { note: "Large JSON Schema — included in the download." }, null, 2)}</pre>}</CardBody>
          </Card>
        </div>
      )}

      {tab === "diff" && (
        <Card>
          <CardHeader title="Configuration differences" action={siblings.length > 1 && (
            <form className="flex items-center gap-2 text-[13px]"><input type="hidden" name="tab" value="diff" />From
              <select name="compare" defaultValue={compareTo} className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1">{siblings.filter((s) => s.id !== id).map((s) => <option key={s.id} value={s.id}>v{s.version}</option>)}</select>
              <button className="text-[var(--brand)]">Compare</button></form>)} />
          {!compareTo ? <EmptyState compact title="Only one version" description="Publish another version to compare." /> : diff.length === 0 ? <EmptyState compact icon="check" title="No differences" /> : (
            <div className="table-wrap"><table className="table-cl">
              <thead><tr><th>Path</th><th>Change</th><th>Before</th><th>After</th></tr></thead>
              <tbody>{diff.map((d) => (
                <tr key={d.path}><td className="mono text-[12px]">{d.path}</td><td><Badge tone={d.kind === "added" ? "success" : d.kind === "removed" ? "danger" : "warning"}>{d.kind}</Badge></td>
                  <td className="mono max-w-xs truncate text-[12px]">{d.before === undefined ? "—" : JSON.stringify(d.before)}</td><td className="mono max-w-xs truncate text-[12px]">{d.after === undefined ? "—" : JSON.stringify(d.after)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
      )}

      {tab === "deployments" && (
        <Card>
          {deps.length === 0 ? <EmptyState icon="rocket" title="No client runs this version" action={<ButtonLink href={`/agency/deploy?version=${id}`}>Deploy</ButtonLink>} /> : (
            <ul className="divide-y divide-[var(--border)]">{deps.map(({ d, ws }) => (
              <li key={d.id}><Link className="flex items-center gap-3 px-5 py-3 hover:bg-[var(--surface-2)]" href={`/w/${d.workspaceId}/agent`}><span className="flex-1 font-medium">{ws}</span><StatusBadge status={d.status} /></Link></li>
            ))}</ul>
          )}
          <CardBody><KeyValue items={[["Schema", bp.schemaVersion], ["Minimum app version", bp.compatibility.minAppVersion], ["Content hash", <code key="h" className="mono text-[12px]">{p.version.contentHash.slice(0, 16)}…</code>]]} /></CardBody>
        </Card>
      )}
    </>
  );
}
