import Link from "next/link";
import { TemplateEditor } from "@/components/template-editor";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Field, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Timestamp } from "@/components/ui/kit";
import { agentConfigSchema } from "@/lib/blueprint/schema";
import { NODE_REGISTRY } from "@/lib/workflow/nodes";
import { archiveTemplateAction, duplicateTemplateAction, publishVersionAction, saveTemplateAction } from "@/server/actions/agency";
import { pageOrg } from "@/server/page-ctx";
import { checkConfig, deploymentsOfTemplate, getTemplate, listVersions } from "@/server/services/blueprints";

export const metadata = { title: "Agent configuration" };

export default async function TemplatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ imported?: string }> }) {
  const org = await pageOrg();
  const { id } = await params;
  const { imported } = await searchParams;
  const t = await getTemplate(org, id);
  const [versions, deps] = await Promise.all([listVersions(org, t.id), deploymentsOfTemplate(org, t.id)]);
  const check = checkConfig(t.draftConfig);
  const config = check.config ?? agentConfigSchema.parse(t.draftConfig);
  const nodeLabels = Object.fromEntries([...NODE_REGISTRY.values()].map((n) => [n.type, n.label]));
  return (
    <>
      <PageHeader eyebrow="Agent template" title={t.name} description={<>Blueprint identity <code className="mono text-[12px]">{t.blueprintUid}</code> — shared by every version and installation.</>} back={{ href: "/agency/templates", label: "Templates" }}
        actions={<>
          <ActionForm action={duplicateTemplateAction} showErrorBanner={false}><input type="hidden" name="id" value={t.id} /><SubmitButton variant="secondary">Duplicate</SubmitButton></ActionForm>
          <ActionForm action={archiveTemplateAction} showErrorBanner={false}><input type="hidden" name="id" value={t.id} /><ConfirmSubmit title="Archive template?" description="Its versions stay available to existing deployments. Templates with active deployments cannot be archived." confirmLabel="Archive">Archive</ConfirmSubmit></ActionForm>
        </>} />
      {imported && <div className="mb-5"><Notice tone="success" title="Blueprint imported">The imported version is listed below. It has not been deployed anywhere, and existing deployments were not changed.</Notice></div>}
      {check.errors.length > 0 && <div className="mb-5"><Notice tone="danger" title="This draft cannot be published yet">{check.errors.slice(0, 6).map((e) => <div key={e}>{e}</div>)}</Notice></div>}
      {check.warnings.length > 0 && <div className="mb-5"><Notice tone="warning">{check.warnings.slice(0, 6).map((e) => <div key={e}>{e}</div>)}</Notice></div>}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card><CardBody><TemplateEditor action={saveTemplateAction} id={t.id} name={t.name} description={t.description} config={config} nodeLabels={nodeLabels} /></CardBody></Card>
        <div className="space-y-6">
          <Card>
            <CardHeader title="Publish a version" description="Freezes the current draft as an immutable, deployable blueprint version." />
            <CardBody>
              <ActionForm action={publishVersionAction} className="space-y-3" resetOnSuccess>
                <input type="hidden" name="id" value={t.id} />
                <Field label="Change type" htmlFor="bump"><Select id="bump" name="bump" defaultValue={versions.length ? "minor" : "major"}><option value="patch">Patch — fixes</option><option value="minor">Minor — improvements</option><option value="major">Major — breaking</option></Select></Field>
                <Field label="Changelog" htmlFor="changelog"><Textarea id="changelog" name="changelog" rows={3} placeholder="What changed for clients?" /></Field>
                <SubmitButton disabled={check.errors.length > 0}>Publish</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Versions" />
            {versions.length === 0 ? <EmptyState compact icon="package" title="Nothing published yet" /> : (
              <ul className="divide-y divide-[var(--border)]">
                {versions.map((v) => (
                  <li key={v.id} className="px-5 py-3">
                    <div className="flex items-center gap-2"><Link href={`/agency/blueprints/${v.id}`} className="font-semibold hover:text-[var(--brand)]">v{v.version}</Link>{v.source === "imported" && <Badge tone="info">imported</Badge>}<span className="ml-auto text-[12px] text-[var(--text-muted)]"><Timestamp value={v.createdAt} /></span></div>
                    {v.changelog && <p className="mt-1 line-clamp-2 text-[12.5px] text-[var(--text-muted)]">{v.changelog}</p>}
                    <div className="mt-1.5 flex gap-3 text-[12.5px]"><a className="text-[var(--brand)]" href={`/api/v1/agency/blueprints/${v.id}/export?format=zip`}>ZIP</a><a className="text-[var(--brand)]" href={`/api/v1/agency/blueprints/${v.id}/export?format=json`}>JSON</a><Link className="text-[var(--brand)]" href={`/agency/blueprints/${v.id}`}>Preview & diff</Link></div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Deployments" />
            {deps.length === 0 ? <EmptyState compact icon="rocket" title="Not deployed" action={versions[0] && <Link href={`/agency/deploy?version=${versions[0].id}`} className="text-[13px] font-medium text-[var(--brand)]">Deploy v{versions[0].version}</Link>} /> : (
              <ul className="divide-y divide-[var(--border)]">{deps.map(({ d, ws, version }) => (
                <li key={d.id}><Link href={`/w/${d.workspaceId}/agent`} className="flex items-center gap-2 px-5 py-2.5 text-[13px] hover:bg-[var(--surface-2)]"><span className="flex-1 truncate font-medium">{ws}</span><Badge>v{version}</Badge><StatusBadge status={d.status} /></Link></li>
              ))}</ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
