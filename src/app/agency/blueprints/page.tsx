import Link from "next/link";
import { BlueprintImporter } from "@/components/blueprint-importer";
import { Badge, Card, CardBody, CardHeader, EmptyState, PageHeader, Timestamp } from "@/components/ui/kit";
import { confirmImportAction, previewImportAction } from "@/server/actions/agency";
import { pageOrg } from "@/server/page-ctx";
import { listAllVersions } from "@/server/services/blueprints";

export const metadata = { title: "Blueprint library" };

export default async function Blueprints() {
  const org = await pageOrg();
  const rows = await listAllVersions(org);
  return (
    <>
      <PageHeader title="Blueprint library" description="Immutable, portable agent versions. Export them as JSON or a ZIP package (or a full client-owned deployment kit), import packages from other installations, and deploy any version to a client." />
      <div className="grid gap-6 xl:grid-cols-[1fr_440px]">
        <Card className="overflow-hidden">
          <CardHeader title="Versions" description={`${rows.length} version${rows.length === 1 ? "" : "s"}`} />
          {rows.length === 0 ? <EmptyState icon="package" title="No blueprints yet" description={<>Publish a version from an <Link className="text-[var(--brand)]" href="/agency/templates">agent template</Link>, or import a package.</>} /> : (
            <div className="table-wrap"><table className="table-cl">
              <thead><tr><th>Blueprint</th><th>Version</th><th>Source</th><th>Created</th><th>Export</th></tr></thead>
              <tbody>{rows.map(({ v, name }) => (
                <tr key={v.id}>
                  <td><Link href={`/agency/blueprints/${v.id}`} className="font-medium hover:text-[var(--brand)]">{name}</Link></td>
                  <td><Badge tone="brand">v{v.version}</Badge></td>
                  <td>{v.source === "imported" ? <Badge tone="info">imported</Badge> : <Badge>published</Badge>}</td>
                  <td><Timestamp value={v.createdAt} /></td>
                  <td className="whitespace-nowrap text-[12.5px]"><a className="text-[var(--brand)]" href={`/api/v1/agency/blueprints/${v.id}/export?format=json`}>JSON</a> · <a className="text-[var(--brand)]" href={`/api/v1/agency/blueprints/${v.id}/export?format=zip`}>ZIP</a> · <a className="text-[var(--brand)]" href={`/api/v1/agency/blueprints/${v.id}/export?format=kit`}>Kit</a></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Card>
        <Card>
          <CardHeader title="Import a blueprint" description="JSON or ZIP packages exported by Cutline. Validated before anything is created." />
          <CardBody><BlueprintImporter preview={previewImportAction} confirm={confirmImportAction} /></CardBody>
        </Card>
      </div>
    </>
  );
}
