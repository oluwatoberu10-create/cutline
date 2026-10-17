import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Checkbox, Input, Select } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, SetupRequired, StatusBadge, Timestamp } from "@/components/ui/kit";
import { addProviderAction, addS3Action, connectYouTubeAction, disconnectAction, testProviderAction } from "@/server/actions/workspace";
import { env } from "@/server/env";
import { pageWs } from "@/server/page-ctx";
import { listConnections, publicConnection } from "@/server/services/integrations";
import { can } from "@/server/tenancy";

export const metadata = { title: "Integrations" };

export default async function Integrations({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ connected?: string }> }) {
  const ws = await pageWs((await params).ws);
  const { connected } = await searchParams;
  const conns = (await listConnections(ws)).map(publicConnection);
  const manage = can(ws.role, "approve");
  const h = <input type="hidden" name="ws" value={ws.workspaceId} />;
  const group = (k: string) => conns.filter((c) => c.kind === k);
  const google = env.google();

  const List = ({ kind }: { kind: string }) => group(kind).length === 0 ? <EmptyState compact icon="plug" title="Not connected" /> : (
    <ul className="divide-y divide-[var(--border)]">{group(kind).map((c) => (
      <li key={c.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">{c.label}{c.shared && <Badge tone="info">agency-shared</Badge>}{c.provider === "mock" && <Badge tone="warning">mock</Badge>}</div>
          <div className="text-[12px] text-[var(--text-muted)]">{c.provider}{c.externalAccountName ? ` · ${c.externalAccountName}` : ""}{c.scopes.length ? ` · scopes: ${c.scopes.join(", ")}` : ""} · checked <Timestamp value={c.lastCheckedAt} tz={ws.timezone} />{c.lastError ? ` · ${c.lastError}` : ""}</div>
        </div>
        <StatusBadge status={c.status} />
        {manage && <ActionForm action={testProviderAction} showErrorBanner={false}>{h}<input type="hidden" name="id" value={c.id} /><SubmitButton size="sm" variant="secondary">Test</SubmitButton></ActionForm>}
        {manage && !c.shared && <ActionForm action={disconnectAction} showErrorBanner={false}>{h}<input type="hidden" name="id" value={c.id} /><ConfirmSubmit title={`Disconnect ${c.label}?`} description={kind === "youtube" ? "Access is revoked at Google and the stored tokens are destroyed. Publishing and syncing stop until reconnected." : "The stored credential is destroyed."} confirmLabel="Disconnect">Disconnect</ConfirmSubmit></ActionForm>}
      </li>
    ))}</ul>
  );

  return (
    <>
      <PageHeader title="Integrations" description="This client's own accounts. Credentials are encrypted at rest, never shown again after saving, and never visible to any other workspace." />
      {connected && <div className="mb-5"><Notice tone="success">Connected “{connected}”. Run a channel sync from Channel insights.</Notice></div>}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="YouTube" description="Official OAuth 2.0 (with PKCE). The creator chooses what to grant." />
          <List kind="youtube" />
          {manage && <CardBody className="border-t border-[var(--border)]">
            {google ? (
              <ActionForm action={connectYouTubeAction} className="space-y-3">{h}
                <div className="flex flex-wrap gap-4 text-[13px]"><Checkbox name="analytics" defaultChecked label="YouTube Analytics" /><Checkbox name="upload" label="Upload videos" /><Checkbox name="manage" label="Captions & playlists" /></div>
                <p className="text-[12px] text-[var(--text-muted)]">Read-only channel access is always requested. Upload is only needed if this workspace publishes.</p>
                <SubmitButton>{group("youtube").length ? "Reconnect / change permissions" : "Connect with Google"}</SubmitButton>
              </ActionForm>
            ) : <SetupRequired title="YouTube OAuth is not configured">An administrator must set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET, with redirect URI <code className="mono">{env.appUrl()}/api/oauth/google/callback</code>. Until then, add a public channel URL on Channel insights.</SetupRequired>}
          </CardBody>}
        </Card>
        <Card>
          <CardHeader title="Language models" description={ws.settings.allowAgencyProviders ? "This workspace may fall back to agency-shared providers." : "Agency-shared providers are disabled for this workspace."} />
          <List kind="llm" />
          {manage && <CardBody className="border-t border-[var(--border)]">
            <ActionForm action={addProviderAction} resetOnSuccess className="grid gap-2 sm:grid-cols-2">{h}<input type="hidden" name="kind" value="llm" />
              <Select name="provider" aria-label="Provider"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option>{env.mockProviders() && <option value="mock">Mock (tests only)</option>}</Select>
              <Input name="label" placeholder="Label" aria-label="Label" />
              <Input name="apiKey" type="password" autoComplete="off" placeholder="API key" aria-label="API key" className="sm:col-span-2" />
              <Input name="model" placeholder="Model override (optional)" aria-label="Model" />
              <SubmitButton variant="secondary">Add</SubmitButton>
            </ActionForm>
          </CardBody>}
        </Card>
        <Card>
          <CardHeader title="Speech-to-text" description="Whisper returns word timings (no speakers); Deepgram can identify speakers." />
          <List kind="transcription" />
          {manage && <CardBody className="border-t border-[var(--border)]">
            <ActionForm action={addProviderAction} resetOnSuccess className="grid gap-2 sm:grid-cols-2">{h}<input type="hidden" name="kind" value="transcription" />
              <Select name="provider" aria-label="Provider"><option value="openai">OpenAI Whisper</option><option value="deepgram">Deepgram</option>{env.mockProviders() && <option value="mock">Mock (tests only)</option>}</Select>
              <Input name="label" placeholder="Label" aria-label="Label" />
              <Input name="apiKey" type="password" autoComplete="off" placeholder="API key" aria-label="API key" className="sm:col-span-2" />
              <SubmitButton variant="secondary">Add</SubmitButton>
            </ActionForm>
          </CardBody>}
        </Card>
        <Card>
          <CardHeader title="Media storage" description={`Default: ${env.storage().driver === "local" ? "this installation's disk" : "the installation's S3 bucket"}. Connect the client's own bucket to keep their footage in their account.`} />
          <List kind="storage" />
          {manage && <CardBody className="border-t border-[var(--border)]">
            <ActionForm action={addS3Action} resetOnSuccess className="grid gap-2 sm:grid-cols-2">{h}
              <Input name="label" placeholder="Label" aria-label="Label" /><Input name="bucket" placeholder="Bucket" aria-label="Bucket" required />
              <Input name="region" placeholder="Region" aria-label="Region" /><Input name="endpoint" placeholder="Endpoint (R2/MinIO, optional)" aria-label="Endpoint" />
              <Input name="accessKeyId" placeholder="Access key id" aria-label="Access key" autoComplete="off" /><Input name="secretAccessKey" type="password" placeholder="Secret" aria-label="Secret" autoComplete="off" />
              <Checkbox name="forcePathStyle" label="Path-style URLs" /><SubmitButton variant="secondary">Connect bucket</SubmitButton>
            </ActionForm>
            <p className="mt-2 text-[12px] text-[var(--text-muted)]">New uploads use it once it is bound as <code className="mono">media_storage</code> (Agent → Bindings) or when it is the only bucket.</p>
          </CardBody>}
        </Card>
      </div>
      {!manage && <p className="mt-4 text-[12.5px] text-[var(--text-muted)]">Only the workspace owner or an agency admin can change integrations.</p>}
    </>
  );
}
