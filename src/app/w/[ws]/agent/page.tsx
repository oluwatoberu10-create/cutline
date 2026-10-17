import Link from "next/link";
import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { ButtonLink } from "@/components/ui/button";
import { Field, Select } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, KeyValue, Notice, PageHeader, SetupRequired, StatusBadge, Timestamp } from "@/components/ui/kit";
import { nodeSpec } from "@/lib/workflow/nodes";
import { applyVersionAction, pauseAction, rollbackAction, startRunAction } from "@/server/actions/workspace";
import { pageWs } from "@/server/page-ctx";
import { effectiveConfig } from "@/server/services/agent-config";
import { availableUpdates, getDeployment, listRevisions, previewVersionChange } from "@/server/services/deployments";
import { listIdeas } from "@/server/services/ideas";
import { listAssets } from "@/server/services/media";
import { can } from "@/server/tenancy";

export const metadata = { title: "Agent" };

export default async function AgentPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ preview?: string }> }) {
  const ws = await pageWs((await params).ws);
  const { preview } = await searchParams;
  const dep = await getDeployment(ws);
  const agency = can(ws.role, "agency"), edit = can(ws.role, "edit");
  const h = <input type="hidden" name="ws" value={ws.workspaceId} />;
  if (!dep) {
    return (
      <>
        <PageHeader title="Agent" />
        <SetupRequired title="No agent deployed" action={agency ? <ButtonLink href={`/agency/deploy?ws=${ws.workspaceId}`}>Deploy a blueprint</ButtonLink> : undefined}>
          An agency administrator deploys a blueprint to this workspace and connects the creator&apos;s own accounts. Until then, the media library, editor and publishing tools work manually with the starter configuration.
        </SetupRequired>
      </>
    );
  }
  const d = dep.d;
  const [{ config }, updates, revs, sources, ideas] = await Promise.all([effectiveConfig(ws), agency ? availableUpdates(ws) : [], agency ? listRevisions(ws) : [], listAssets(ws, { role: "source" }), listIdeas(ws, { status: "approved" })]);
  const pv = preview && agency ? await previewVersionChange(ws, preview).catch(() => null) : null;
  const m = config.modules;
  return (
    <>
      <PageHeader eyebrow="Deployed agent" title={`${dep.templateName}`}
        description={<span className="flex flex-wrap items-center gap-2"><Badge tone="brand">v{dep.version}</Badge><StatusBadge status={d.status} /><span>revision {d.currentRevision} · activated <Timestamp value={d.activatedAt} tz={ws.timezone} /></span></span>}
        actions={agency && <>
          {d.status !== "active" && d.status !== "paused" && <ButtonLink href={`/agency/deploy?ws=${ws.workspaceId}`}>Continue deployment</ButtonLink>}
          {(d.status === "active" || d.status === "paused") && <ActionForm action={pauseAction} showErrorBanner={false}>{h}<input type="hidden" name="pause" value={String(d.status === "active")} /><SubmitButton variant="secondary">{d.status === "active" ? "Pause agent" : "Resume agent"}</SubmitButton></ActionForm>}
          <ButtonLink variant="secondary" href={`/agency/deploy?ws=${ws.workspaceId}&step=4`}>Bindings & checks</ButtonLink>
        </>} />

      {updates.length > 0 && (
        <div className="mb-6"><Notice tone="brand" title={`Blueprint update available: v${updates[0].version}`}>
          Nothing changes until you review and apply it. {updates.map((u) => <Link key={u.id} className="ml-2 font-semibold underline" href={`?preview=${u.id}`}>Review v{u.version}</Link>)}
        </Notice></div>
      )}
      {pv && (
        <Card className="mb-6">
          <CardHeader title={`Apply v${pv.target.version} to this client?`} description={pv.changelog || "No changelog."} action={<Link href="?" className="text-[13px] text-[var(--text-muted)]">Close</Link>} />
          <CardBody className="space-y-3">
            {pv.problem ? <Notice tone="danger">{pv.problem}</Notice> : pv.unchanged ? <Notice tone="info">This client&apos;s effective configuration would not change.</Notice> : (
              <div className="table-wrap"><table className="table-cl"><thead><tr><th>Setting</th><th>Now</th><th>After</th></tr></thead>
                <tbody>{pv.diff.map((x) => <tr key={x.path}><td className="mono text-[12px]">{x.path}</td><td className="mono max-w-xs truncate text-[12px]">{JSON.stringify(x.before)}</td><td className="mono max-w-xs truncate text-[12px] font-semibold">{JSON.stringify(x.after)}</td></tr>)}</tbody></table></div>
            )}
            {pv.newIntegrations.length > 0 && <Notice tone="warning">New integrations required: {pv.newIntegrations.join(", ")}. Bind them after applying.</Notice>}
            {!pv.problem && <ActionForm action={applyVersionAction}>{h}<input type="hidden" name="versionId" value={pv.target.id} /><ConfirmSubmit variant="primary" danger={false} title={`Apply v${pv.target.version}?`} description="The client's overrides and bindings are kept. A new revision is recorded so you can roll back." confirmLabel="Apply update">Apply update</ConfirmSubmit></ActionForm>}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <Card>
            <CardHeader title="Workflows" description="Start a run of the deployed agent. Each run snapshots the configuration it started with." />
            {d.status !== "active" ? <CardBody><Notice tone="warning">The agent is {d.status}; workflows can run once it is active.</Notice></CardBody> : (
              <ul className="divide-y divide-[var(--border)]">{config.workflows.map((wf) => (
                <li key={wf.key} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{wf.name}</span><Badge>{wf.trigger.type}{wf.trigger.value ? `: ${wf.trigger.value}` : ""}</Badge></div>
                  <p className="mt-1 text-[13px] text-[var(--text-muted)]">{wf.description}</p>
                  <p className="mt-1.5 text-[12px] text-[var(--text-subtle)]">{wf.nodes.map((n) => n.label ?? nodeSpec(n.type)?.label ?? n.type).join(" → ")}</p>
                  {edit && (
                    <ActionForm action={startRunAction} className="mt-3 flex flex-wrap items-end gap-2">
                      {h}<input type="hidden" name="workflowKey" value={wf.key} />
                      {wf.inputs.map((inp) => (
                        <Field key={inp.key} label={inp.label} htmlFor={`${wf.key}-${inp.key}`} className="min-w-56">
                          <Select id={`${wf.key}-${inp.key}`} name={`in_${inp.key}`} required={inp.required} defaultValue="">
                            <option value="">{inp.required ? "Choose…" : "None"}</option>
                            {inp.kind === "media_asset" && sources.filter((s) => s.status !== "failed").map((s) => <option key={s.id} value={s.id}>{s.originalFilename}{s.status !== "ready" ? " (processing)" : ""}</option>)}
                            {inp.kind === "content_idea" && ideas.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
                          </Select>
                        </Field>
                      ))}
                      <SubmitButton>Run</SubmitButton>
                    </ActionForm>
                  )}
                </li>
              ))}</ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Effective configuration" description="The blueprint plus this client's overrides." />
            <CardBody>
              <KeyValue items={[
                ["Ideation", m.ideation.enabled ? `on · ${m.ideation.batchSize} per batch · refresh ${m.ideation.refresh}` : "off"],
                ["Editing", m.editing.enabled ? `${m.editing.mode.replace("_", "-")} · pauses > ${m.editing.rules.pauseThresholdSeconds}s · fillers ${m.editing.rules.removeFillerWords ? "on" : "off"} · captions ${m.editing.captions.enabled ? (m.editing.captions.burnIn ? "burned in" : "sidecar") : "off"}` : "off"],
                ["Publishing", m.publishing.enabled ? `${m.publishing.mode.replace("_", "-")} · default ${m.publishing.defaultPrivacy}` : "off"],
                ["Language model", config.models.llm.preferences.map((p) => `${p.provider}/${p.model}`).join(" → ")],
                ["Transcription", config.models.transcription.preferences.map((p) => `${p.provider}/${p.model}`).join(" → ")],
                ["Approval gates", Object.entries(config.approvalGates).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"],
                ["Retries", `${config.policies.retry.maxAttempts} attempts, ${config.policies.retry.backoffSeconds}s backoff`],
              ]} />
            </CardBody>
          </Card>
        </div>
        {agency && (
          <Card className="h-fit">
            <CardHeader title="Revisions" description="Every applied configuration. Roll back restores the exact version, overrides and bindings." />
            {revs.length === 0 ? <EmptyState compact title="No revisions yet" /> : (
              <ul className="divide-y divide-[var(--border)]">{revs.map(({ r, version }) => (
                <li key={r.id} className="flex items-center gap-2 px-5 py-2.5 text-[12.5px]">
                  <Badge tone={r.revision === d.currentRevision ? "brand" : "neutral"}>#{r.revision}</Badge>
                  <div className="min-w-0 flex-1"><div className="truncate">{r.reason}</div><div className="text-[var(--text-subtle)]">v{version} · <Timestamp value={r.createdAt} tz={ws.timezone} /></div></div>
                  {r.revision !== d.currentRevision && <ActionForm action={rollbackAction} showErrorBanner={false}>{h}<input type="hidden" name="revision" value={r.revision} /><ConfirmSubmit variant="ghost" danger={false} title={`Roll back to revision ${r.revision}?`} description="The blueprint version, overrides and bindings of that revision are restored as a new revision." confirmLabel="Roll back">Restore</ConfirmSubmit></ActionForm>}
                </li>
              ))}</ul>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
