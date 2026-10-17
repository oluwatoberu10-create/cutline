import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Timestamp } from "@/components/ui/kit";
import { createTemplateAction } from "@/server/actions/agency";
import { pageOrg } from "@/server/page-ctx";
import { listAllVersions, listTemplates } from "@/server/services/blueprints";

export const metadata = { title: "Agent templates" };

export default async function Templates() {
  const org = await pageOrg();
  const [rows, versions] = await Promise.all([listTemplates(org), listAllVersions(org)]);
  return (
    <>
      <PageHeader title="Agent templates" description="Configure an agent once — instructions, workflows, editing rules, render presets, SEO rules and approval gates — then publish versions to deploy to any client." />
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card className="overflow-hidden">
          {rows.length === 0 ? <EmptyState icon="layers" title="No templates yet" description="Create one from the starter configuration, or import a blueprint." action={<Link href="/agency/blueprints" className="text-[13px] font-medium text-[var(--brand)]">Import a blueprint</Link>} /> : (
            <ul className="divide-y divide-[var(--border)]">
              {rows.map(({ template, latest, versionCount, deployments, active }) => (
                <li key={template.id}>
                  <Link href={`/agency/templates/${template.id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-[var(--surface-2)]">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--brand-soft)] text-[14px] font-bold text-[var(--brand)]">{template.name.charAt(0)}</span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{template.name}</div>
                      <div className="truncate text-[12.5px] text-[var(--text-muted)]">{template.description || "No description"}</div>
                    </div>
                    <div className="hidden text-right text-[12px] text-[var(--text-muted)] sm:block">
                      <div>{latest ? <Badge tone="brand">v{latest.version}</Badge> : <Badge>Unpublished</Badge>} <span className="ml-1">{versionCount} version{versionCount === 1 ? "" : "s"}</span></div>
                      <div className="mt-1">{active} active · {deployments} deployment{deployments === 1 ? "" : "s"} · edited <Timestamp value={template.updatedAt} /></div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader title="New template" />
          <CardBody>
            <ActionForm action={createTemplateAction} className="space-y-4">
              <Field label="Name" htmlFor="name" required><Input id="name" name="name" placeholder="Tutorial channel agent" required /></Field>
              <Field label="Description" htmlFor="description"><Textarea id="description" name="description" rows={3} /></Field>
              <Field label="Start from" htmlFor="fromVersionId">
                <Select id="fromVersionId" name="fromVersionId" defaultValue="">
                  <option value="">Starter configuration</option>
                  {versions.map(({ v, name }) => <option key={v.id} value={v.id}>{name} v{v.version}</option>)}
                </Select>
              </Field>
              <SubmitButton>Create template</SubmitButton>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
