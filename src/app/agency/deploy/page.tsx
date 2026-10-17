import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agentDeployments, workspaces } from "@/db/schema";
import { ActionForm, SubmitButton } from "@/components/ui/action-form";
import { ButtonLink } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge } from "@/components/ui/kit";
import { cn } from "@/lib/utils";
import { blueprintSchema } from "@/lib/blueprint/schema";
import { startDeploymentAction } from "@/server/actions/agency";
import {
  activateAction, addProviderAction, addS3Action, bindAction, connectYouTubeAction, deploymentConfigAction, deploymentProfileAction, testDeploymentAction, validateDeploymentAction,
} from "@/server/actions/workspace";
import { pageActor } from "@/server/auth";
import { env } from "@/server/env";
import { mergeConfig } from "@/server/services/agent-config";
import { getVersion, listAllVersions } from "@/server/services/blueprints";
import { deploymentDiff, getDeployment, type Check } from "@/server/services/deployments";
import { listConnections, publicConnection } from "@/server/services/integrations";
import { getProfile } from "@/server/services/workspaces";
import { requireWorkspace } from "@/server/tenancy";
import { pageOrg } from "@/server/page-ctx";

export const metadata = { title: "Deploy an agent" };

const STEPS = ["Blueprint", "Workspace", "Client profile", "Connect accounts", "Configure", "Validate", "Test", "Review", "Activate"];

export default async function Deploy({ searchParams }: { searchParams: Promise<{ ws?: string; step?: string; version?: string }> }) {
  const org = await pageOrg();
  const actor = await pageActor();
  const sp = await searchParams;
  const versions = await listAllVersions(org);

  if (!sp.ws || !(await db.select({ id: agentDeployments.id }).from(agentDeployments).where(eq(agentDeployments.workspaceId, sp.ws)).limit(1))[0]) {
    const free = await db.select({ ws: workspaces, dep: agentDeployments.status }).from(workspaces).leftJoin(agentDeployments, eq(agentDeployments.workspaceId, workspaces.id))
      .where(and(eq(workspaces.orgId, org.orgId), eq(workspaces.status, "active")));
    return (
      <>
        <PageHeader title="Deploy an agent" description="Turn a blueprint into a working, isolated agent for one client — with their own accounts, settings and data." />
        <Stepper current={1} />
        {versions.length === 0 ? <Card><EmptyState icon="package" title="No blueprint versions yet" description="Publish a version of an agent template or import a blueprint first." action={<ButtonLink href="/agency/templates">Agent templates</ButtonLink>} /></Card> : (
          <Card className="max-w-2xl">
            <CardBody>
              <ActionForm action={startDeploymentAction} className="space-y-5">
                <Field label="1. Blueprint version" htmlFor="v">
                  <Select id="v" name="blueprintVersionId" defaultValue={sp.version ?? versions[0].v.id} required>
                    {versions.map(({ v, name }) => <option key={v.id} value={v.id}>{name} — v{v.version}{v.source === "imported" ? " (imported)" : ""}</option>)}
                  </Select>
                </Field>
                <Field label="2. Client workspace" htmlFor="w" hint="Workspaces that already run an active agent are updated from their Agent page instead.">
                  <Select id="w" name="workspaceId" defaultValue={sp.ws ?? "new"}>
                    <option value="new">+ Create a new client workspace</option>
                    {free.map(({ ws, dep }) => <option key={ws.id} value={ws.id} disabled={Boolean(dep && dep !== "draft")}>{ws.name}{dep && dep !== "draft" ? ` (agent ${dep})` : ""}</option>)}
                  </Select>
                </Field>
                <div className="grid gap-3 rounded-[var(--radius-field)] border border-dashed border-[var(--border)] p-3 sm:grid-cols-3">
                  <Field label="New client name" htmlFor="nn"><Input id="nn" name="newName" placeholder="Only for a new workspace" /></Field>
                  <Field label="Contact email" htmlFor="ne"><Input id="ne" name="newEmail" type="email" /></Field>
                  <Field label="Timezone" htmlFor="tz"><Input id="tz" name="timezone" defaultValue="UTC" /></Field>
                </div>
                <SubmitButton>Continue</SubmitButton>
              </ActionForm>
            </CardBody>
          </Card>
        )}
      </>
    );
  }

  const ws = await requireWorkspace(actor, sp.ws, "agency");
  const dep = (await getDeployment(ws))!;
  const d = dep.d;
  const version = await getVersion(org, d.blueprintVersionId);
  const bp = blueprintSchema.parse(version.content);
  let effective = bp.config, configError: string | null = null;
  try { effective = mergeConfig(bp.config, d.overrides); } catch (e) { configError = (e as Error).message; }
  const step = Math.min(9, Math.max(3, Number(sp.step) || Math.min(d.wizardStep, 9)));
  const conns = (await listConnections(ws)).map(publicConnection);
  const bindings = d.bindings as Record<string, string>;
  const profile = await getProfile(ws);
  const validation = d.validation as { ok: boolean; checks: Check[]; at: string } | null;
  const tests = d.testResults as { results: Check[]; at: string } | null;
  const base = `/agency/deploy?ws=${ws.workspaceId}`;
  const hidden = <input type="hidden" name="ws" value={ws.workspaceId} />;
  const next = (n: number) => <ButtonLink href={`${base}&step=${n}`} variant="secondary">Next: {STEPS[n - 1]}</ButtonLink>;

  return (
    <>
      <PageHeader title={`Deploy ${bp.blueprint.name} v${bp.blueprint.version}`} description={<>to <Link className="font-medium text-[var(--text)] underline" href={`/w/${ws.workspaceId}`}>{ws.workspaceName}</Link> · deployment <StatusBadge status={d.status} /></>} back={{ href: "/agency/deploy", label: "Deploy" }} />
      <Stepper current={step} base={base} reached={Math.max(d.wizardStep, 3)} />
      {configError && <div className="mb-4"><Notice tone="danger">{configError}</Notice></div>}

      {step === 3 && (
        <Card className="max-w-3xl"><CardHeader title="3. Client profile" description={`The agent personalises analysis, ideas and metadata from this. Required by the blueprint: ${bp.config.requiredClientSettings.join(", ") || "none"}.`} />
          <CardBody>
            <ActionForm action={deploymentProfileAction} className="grid gap-4 sm:grid-cols-2">
              {hidden}
              <Field label="Channel niche" htmlFor="niche" required={bp.config.requiredClientSettings.includes("niche")}><Input id="niche" name="niche" defaultValue={profile.niche} placeholder={bp.config.exampleClientSettings?.niche as string} /></Field>
              <Field label="Target audience" htmlFor="ta" required={bp.config.requiredClientSettings.includes("targetAudience")}><Input id="ta" name="targetAudience" defaultValue={profile.targetAudience} /></Field>
              <Field label="Audience problems (one per line)" htmlFor="ap"><Textarea id="ap" name="audienceProblems" rows={3} defaultValue={profile.audienceProblems.join("\n")} /></Field>
              <Field label="Preferred formats (one per line)" htmlFor="fm"><Textarea id="fm" name="formats" rows={3} defaultValue={profile.formats.join("\n")} placeholder={"tutorials\nreviews"} /></Field>
              <Field label="Tone and personality" htmlFor="tone" required={bp.config.requiredClientSettings.includes("tone")}><Input id="tone" name="tone" defaultValue={profile.tone} /></Field>
              <Field label="Publishing frequency" htmlFor="pf"><Input id="pf" name="publishingFrequency" defaultValue={profile.publishingFrequency} placeholder="Weekly" /></Field>
              <Field label="Content goals" htmlFor="goals" className="sm:col-span-2"><Textarea id="goals" name="goals" rows={2} defaultValue={profile.goals} /></Field>
              <Field label="Brand voice / editing preferences" htmlFor="bv"><Textarea id="bv" name="brandVoice" rows={2} defaultValue={profile.brandVoice} /></Field>
              <Field label="Topics to avoid (one per line)" htmlFor="av"><Textarea id="av" name="avoidTopics" rows={2} defaultValue={profile.avoidTopics.join("\n")} /></Field>
              <div className="flex gap-2 sm:col-span-2"><SubmitButton>Save profile</SubmitButton>{next(4)}</div>
            </ActionForm>
          </CardBody>
        </Card>
      )}

      {step === 4 && (
        <div className="grid gap-5 lg:grid-cols-2">
          {effective.integrations.map((i) => {
            const options = conns.filter((c) => c.kind === i.kind && c.status !== "revoked");
            const bound = bindings[i.ref];
            return (
              <Card key={i.ref}>
                <CardHeader title={<span className="mono">{i.ref}</span>} description={`${i.kind}${i.required ? " · required" : " · optional"} — ${i.purpose}`} />
                <CardBody className="space-y-4">
                  {options.length > 0 && (
                    <ActionForm action={bindAction} className="flex flex-wrap items-end gap-2">
                      {hidden}<input type="hidden" name="ref" value={i.ref} />
                      <Field label="Use connection" htmlFor={`b-${i.ref}`} className="min-w-52 flex-1">
                        <Select id={`b-${i.ref}`} name="connectionId" defaultValue={bound ?? ""}>
                          <option value="">Automatic (first available{i.kind === "storage" ? "; installation default" : ""})</option>
                          {options.map((c) => <option key={c.id} value={c.id}>{c.label}{c.shared ? " (agency-shared)" : ""} — {c.status}</option>)}
                        </Select>
                      </Field>
                      <SubmitButton variant="secondary">Bind</SubmitButton>
                    </ActionForm>
                  )}
                  {i.kind === "youtube" && (env.google() ? (
                    <ActionForm action={connectYouTubeAction} className="space-y-2">
                      {hidden}<input type="hidden" name="returnTo" value={`${base}&step=4`} />
                      <p className="text-[12.5px] text-[var(--text-muted)]">The client signs in with their own Google account (or you, while they watch). Requested scopes follow the blueprint.</p>
                      <div className="flex flex-wrap gap-4">
                        <Checkbox name="analytics" defaultChecked={i.scopes?.includes("yt-analytics.readonly")} label="Analytics" />
                        <Checkbox name="upload" defaultChecked={i.scopes?.includes("youtube.upload") && effective.modules.publishing.enabled} label="Upload videos" />
                        <Checkbox name="manage" defaultChecked={i.scopes?.includes("youtube.force-ssl")} label="Captions & playlists" />
                      </div>
                      <SubmitButton>Connect a YouTube channel</SubmitButton>
                    </ActionForm>
                  ) : <Notice tone="warning" title="YouTube OAuth is not configured on this installation">Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (redirect URI {env.appUrl()}/api/oauth/google/callback). See docs/INTEGRATIONS.md.</Notice>)}
                  {(i.kind === "llm" || i.kind === "transcription") && (
                    <ActionForm action={addProviderAction} resetOnSuccess className="grid gap-2 sm:grid-cols-[140px_1fr]">
                      {hidden}<input type="hidden" name="kind" value={i.kind} /><input type="hidden" name="label" value={`${ws.workspaceName} ${i.kind}`} />
                      <Select name="provider" aria-label="Provider">{(i.kind === "llm" ? [["anthropic", "Anthropic"], ["openai", "OpenAI"]] : [["openai", "OpenAI Whisper"], ["deepgram", "Deepgram"]]).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
                      <Input name="apiKey" type="password" placeholder="Client's own API key" autoComplete="off" required aria-label="API key" />
                      <div className="sm:col-span-2"><SubmitButton variant="secondary">Add the client's key</SubmitButton></div>
                    </ActionForm>
                  )}
                  {i.kind === "storage" && <p className="text-[12.5px] text-[var(--text-muted)]">Leave on Automatic to use this installation&apos;s storage, or connect the client&apos;s own S3-compatible bucket:</p>}
                  {i.kind === "storage" && (
                    <ActionForm action={addS3Action} resetOnSuccess className="grid gap-2 sm:grid-cols-2">
                      {hidden}<input type="hidden" name="label" value={`${ws.workspaceName} bucket`} />
                      <Input name="bucket" placeholder="Bucket" aria-label="Bucket" /><Input name="region" placeholder="Region (us-east-1)" aria-label="Region" />
                      <Input name="endpoint" placeholder="Endpoint (optional, for R2/MinIO)" aria-label="Endpoint" className="sm:col-span-2" />
                      <Input name="accessKeyId" placeholder="Access key id" aria-label="Access key id" autoComplete="off" /><Input name="secretAccessKey" type="password" placeholder="Secret access key" aria-label="Secret" autoComplete="off" />
                      <Checkbox name="forcePathStyle" label="Path-style URLs" /><div><SubmitButton variant="secondary">Connect bucket</SubmitButton></div>
                    </ActionForm>
                  )}
                </CardBody>
              </Card>
            );
          })}
          <div className="lg:col-span-2">{next(5)}</div>
        </div>
      )}

      {step === 5 && (
        <Card className="max-w-3xl"><CardHeader title="5. Configure for this client" description="Client-specific overrides on top of the blueprint. Anything else stays exactly as the blueprint defines it." />
          <CardBody>
            <ActionForm action={deploymentConfigAction} className="grid gap-5 sm:grid-cols-3">
              {hidden}<input type="hidden" name="step" value="6" />
              <div className="space-y-3"><Checkbox name="ideation" defaultChecked={effective.modules.ideation.enabled} label="Channel intelligence & ideas" />
                <Field label="Ideas per batch" htmlFor="bs"><Input id="bs" name="batchSize" type="number" min={1} max={30} defaultValue={effective.modules.ideation.batchSize} /></Field>
                <Field label="Channel refresh" htmlFor="rf"><Select id="rf" name="refresh" defaultValue={effective.modules.ideation.refresh}><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></Field></div>
              <div className="space-y-3"><Checkbox name="editing" defaultChecked={effective.modules.editing.enabled} label="Footage editing" />
                <Field label="Editing mode" htmlFor="em"><Select id="em" name="editingMode" defaultValue={effective.modules.editing.mode}><option value="assisted">Assisted</option><option value="review_first">Review-first (recommended)</option><option value="automatic">Automatic</option></Select></Field>
                <Field label="Pause threshold (s)" htmlFor="pt"><Input id="pt" name="pauseThreshold" type="number" step="0.1" defaultValue={effective.modules.editing.rules.pauseThresholdSeconds} /></Field>
                <Field label="Noise reduction" htmlFor="nr"><Select id="nr" name="noiseReduction" defaultValue={effective.modules.editing.audio.noiseReduction}><option value="off">Off</option><option value="light">Light</option><option value="medium">Medium</option><option value="strong">Strong</option></Select></Field>
                <Checkbox name="removeFillers" defaultChecked={effective.modules.editing.rules.removeFillerWords} label="Remove filler words" />
                <Checkbox name="captions" defaultChecked={effective.modules.editing.captions.enabled} label="Captions" />
                <Checkbox name="burnIn" defaultChecked={effective.modules.editing.captions.burnIn} label="Burn in captions" /></div>
              <div className="space-y-3"><Checkbox name="publishing" defaultChecked={effective.modules.publishing.enabled} label="YouTube publishing" />
                <Field label="Publishing mode" htmlFor="pm"><Select id="pm" name="publishMode" defaultValue={effective.modules.publishing.mode}><option value="manual">Manual</option><option value="approval">Approval-based (default)</option><option value="rule_based">Rule-based</option></Select></Field>
                <Field label="Default visibility" htmlFor="pv"><Select id="pv" name="defaultPrivacy" defaultValue={effective.modules.publishing.defaultPrivacy}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></Select></Field>
                <p className="text-[12px] text-[var(--text-muted)]">Processing limits and retention live in the workspace&apos;s <Link className="text-[var(--brand)]" href={`/w/${ws.workspaceId}/settings`}>settings</Link>.</p></div>
              <div className="flex gap-2 sm:col-span-3"><SubmitButton>Save configuration</SubmitButton>{next(6)}</div>
            </ActionForm>
          </CardBody>
        </Card>
      )}

      {step === 6 && <ChecksStep title="6. Validate requirements" description="Checks the configuration, profile, every required integration and scope, FFmpeg and the workflow graphs — for this client." action={validateDeploymentAction} hidden={hidden} checks={validation?.checks ?? null} cta="Run validation" nextLink={validation?.ok ? next(7) : null} />}
      {step === 7 && <ChecksStep title="7. Test connections and a sample workflow" description="Tests each connection against its provider, runs FFmpeg on a generated clip, and dry-runs every workflow's branches for this client's configuration. Nothing is published and no client content is used." action={testDeploymentAction} hidden={hidden} checks={tests?.results ?? null} cta="Run tests" nextLink={tests ? next(8) : null} />}

      {step === 8 && <ReviewStep wsId={ws.workspaceId} next={next(9)} />}

      {step === 9 && (
        <Card className="max-w-2xl"><CardHeader title="9. Activate" />
          <CardBody className="space-y-4">
            {d.status === "active" ? <Notice tone="success" title="This agent is active">Manage it, apply updates or roll back from the workspace&apos;s <Link className="underline" href={`/w/${ws.workspaceId}/agent`}>Agent page</Link>.</Notice> : (
              <>
                <p className="text-[13.5px] text-[var(--text-muted)]">Activation re-runs validation, records revision 1 of this client&apos;s configuration (for rollback) and lets workflows run. Uploads still follow the approval mode you chose.</p>
                <ActionForm action={activateAction}>{hidden}<SubmitButton disabled={!validation?.ok}>Activate agent</SubmitButton></ActionForm>
                {!validation?.ok && <Notice tone="warning">Validation has not passed yet — go back to step 6.</Notice>}
              </>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}

async function ReviewStep({ wsId, next }: { wsId: string; next: React.ReactNode }) {
  const actor = await pageActor();
  const ws = await requireWorkspace(actor, wsId, "agency");
  const { diff, bindings } = await deploymentDiff(ws);
  return (
    <Card><CardHeader title="8. Differences from the blueprint" description="Exactly what this client's agent does differently from the blueprint it was deployed from." />
      {diff.length === 0 ? <CardBody><Notice tone="info">No overrides — this client runs the blueprint as published.</Notice></CardBody> : (
        <div className="table-wrap"><table className="table-cl"><thead><tr><th>Setting</th><th>Blueprint</th><th>This client</th></tr></thead>
          <tbody>{diff.map((x) => <tr key={x.path}><td className="mono text-[12px]">{x.path}</td><td className="mono text-[12px]">{JSON.stringify(x.before)}</td><td className="mono text-[12px] font-semibold">{JSON.stringify(x.after)}</td></tr>)}</tbody></table></div>
      )}
      <CardBody className="space-y-2 border-t border-[var(--border)]">
        <div className="text-[13px] font-semibold">Integration bindings</div>
        {Object.keys(bindings).length ? Object.entries(bindings).map(([k, v]) => <div key={k} className="text-[12.5px]"><code className="mono">{k}</code> → connection <code className="mono">{v.slice(0, 8)}</code></div>) : <p className="text-[12.5px] text-[var(--text-muted)]">Automatic resolution for every reference.</p>}
        <div className="pt-2">{next}</div>
      </CardBody>
    </Card>
  );
}

function ChecksStep({ title, description, action, hidden, checks, cta, nextLink }: { title: string; description: string; action: typeof validateDeploymentAction; hidden: React.ReactNode; checks: Check[] | null; cta: string; nextLink: React.ReactNode }) {
  return (
    <Card><CardHeader title={title} description={description} action={<ActionForm action={action} showErrorBanner={false}>{hidden}<SubmitButton pendingLabel="Running…">{cta}</SubmitButton></ActionForm>} />
      {!checks ? <EmptyState compact icon="checkCircle" title="Not run yet" /> : (
        <ul className="divide-y divide-[var(--border)]">{checks.map((c) => (
          <li key={c.id} className="flex items-start gap-3 px-5 py-3"><StatusBadge status={c.status} /><div className="min-w-0"><div className="text-[13.5px] font-medium">{c.label}</div><div className="text-[12.5px] text-[var(--text-muted)]">{c.message}</div></div></li>
        ))}</ul>
      )}
      {nextLink && <CardBody className="border-t border-[var(--border)]">{nextLink}</CardBody>}
    </Card>
  );
}

function Stepper({ current, base, reached = 2 }: { current: number; base?: string; reached?: number }) {
  return (
    <ol className="mb-6 flex flex-wrap gap-1.5" aria-label="Deployment steps">
      {STEPS.map((s, i) => {
        const n = i + 1, done = n < (base ? reached : current), active = n === current, linkable = base && n >= 3 && n <= Math.max(reached, current);
        const body = <span className={cn("flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium", active ? "border-[var(--brand)] bg-[var(--brand-soft)] text-[var(--brand)]" : done ? "border-[var(--border)] text-[var(--text)]" : "border-[var(--border)] text-[var(--text-subtle)]")}>
          <span className="tnum">{n}</span>{s}{done && <Badge tone="success" className="px-1 py-0">✓</Badge>}</span>;
        return <li key={s}>{linkable ? <Link href={`${base}&step=${n}`}>{body}</Link> : body}</li>;
      })}
    </ol>
  );
}
