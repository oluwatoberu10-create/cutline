import { ActionForm, ConfirmSubmit, SubmitButton } from "@/components/ui/action-form";
import { Field, Input, Select } from "@/components/ui/field";
import { Badge, Card, CardBody, CardHeader, EmptyState, Notice, PageHeader, StatusBadge, Timestamp } from "@/components/ui/kit";
import { addSharedProviderAction, connectAgencyDriveAction, removeSharedProviderAction, testSharedProviderAction } from "@/server/actions/agency";
import { pageOrg } from "@/server/page-ctx";
import { env } from "@/server/env";
import { versions } from "@/server/media/ffmpeg";
import { listOrgConnections } from "@/server/services/integrations";

export const metadata = { title: "Integrations" };

export default async function AgencyIntegrations() {
  const org = await pageOrg();
  const [all, ff] = await Promise.all([listOrgConnections(org.orgId), versions()]);
  const shared = all.filter((c) => c.kind !== "storage");
  const drives = all.filter((c) => c.kind === "storage" && c.provider === "google_drive");
  const s = env.storage();
  const installation: [string, boolean, string][] = [
    ["YouTube OAuth client", Boolean(env.google()), env.google() ? `Redirect URI: ${env.appUrl()}/api/oauth/google/callback` : "Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET"],
    ["YouTube API key (public research)", Boolean(env.youtubeApiKey()), env.youtubeApiKey() ? "Set" : "Optional: YOUTUBE_API_KEY enables public-channel lookup"],
    ["FFmpeg", Boolean(ff.ffmpeg), ff.ffmpeg ?? "Not found on PATH (FFMPEG_PATH)"],
    ["FFprobe", Boolean(ff.ffprobe), ff.ffprobe ?? "Not found on PATH (FFPROBE_PATH)"],
    ["Media storage", drives.length > 0 || (s.driver === "s3" ? Boolean(s.s3.bucket) : !env.onVercel()), drives.length ? `Google Drive (${drives[0].label.replace("Google Drive · ", "")})` : s.driver === "s3" ? `S3 bucket ${s.s3.bucket ?? "(missing S3_BUCKET)"}` : env.onVercel() ? "Not configured — connect Google Drive below" : `Local disk (${s.localDir})`],
    ["Installation Anthropic key", Boolean(env.anthropicKey()), env.anthropicKey() ? "Set (ANTHROPIC_API_KEY)" : "Not set"],
    ["Installation OpenAI key", Boolean(env.openaiKey()), env.openaiKey() ? "Set (OPENAI_API_KEY)" : "Not set"],
    ["Installation Deepgram key", Boolean(env.deepgramKey()), env.deepgramKey() ? "Set (DEEPGRAM_API_KEY)" : "Not set"],
  ];
  return (
    <>
      <PageHeader title="Integrations" description="What this installation provides, and AI providers the agency can share with client workspaces. Each client's YouTube account and storage are always their own." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="lg:col-span-2">
          <CardHeader title="Google Drive — default media storage" description="Footage, previews and renders for every client without storage of its own are kept in this Drive folder. A client can still connect their own Drive or bucket in their workspace." />
          <CardBody className="space-y-4">
            {drives.length > 0 && (
              <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-field)] border border-[var(--border)]">
                {drives.map((c, i) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{c.label} {i === 0 && <Badge tone="brand">in use</Badge>}</div><div className="text-[12px] text-[var(--text-muted)]">{c.externalAccountName} · {c.scopes.includes("drive") ? "full Drive access (your folder)" : "Cutline's own folder only"} · checked <Timestamp value={c.lastCheckedAt} />{c.lastError ? ` · ${c.lastError}` : ""}</div></div>
                    <StatusBadge status={c.status} />
                    <ActionForm action={testSharedProviderAction} showErrorBanner={false}><input type="hidden" name="id" value={c.id} /><SubmitButton size="sm" variant="secondary">Test</SubmitButton></ActionForm>
                    <ActionForm action={removeSharedProviderAction} showErrorBanner={false}><input type="hidden" name="id" value={c.id} /><ConfirmSubmit title="Disconnect this Drive?" description="Cutline loses access to media stored there (files stay in your Drive). New uploads need another storage connection." confirmLabel="Disconnect">Disconnect</ConfirmSubmit></ActionForm>
                  </li>
                ))}
              </ul>
            )}
            {env.google() ? (
              <ActionForm action={connectAgencyDriveAction} className="flex flex-wrap items-end gap-3">
                <Field label="Drive folder link (optional)" htmlFor="folderLink" className="min-w-72 flex-1" hint="Paste a folder you can edit (…/drive/folders/…). Leave empty and Cutline creates a “Cutline Media” folder and can only see its own files."><Input id="folderLink" name="folderLink" placeholder="https://drive.google.com/drive/folders/…" /></Field>
                <SubmitButton>{drives.length ? "Connect another Drive" : "Connect Google Drive"}</SubmitButton>
              </ActionForm>
            ) : <Notice tone="warning">Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.</Notice>}
            <p className="text-[12px] text-[var(--text-muted)]">Requires the <strong>Google Drive API</strong> to be enabled in the same Google Cloud project as your YouTube OAuth client.</p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="This installation" description="Read from environment variables. Values are never displayed." />
          <ul className="divide-y divide-[var(--border)]">
            {installation.map(([label, ok, detail]) => (
              <li key={label} className="flex items-start gap-3 px-5 py-3"><Badge tone={ok ? "success" : "warning"}>{ok ? "ready" : "not set"}</Badge><div><div className="text-[13.5px] font-medium">{label}</div><div className="text-[12.5px] text-[var(--text-muted)]">{detail}</div></div></li>
            ))}
          </ul>
          {env.mockProviders() && <CardBody><Notice tone="warning">Mock providers are enabled (CUTLINE_ENABLE_MOCK_PROVIDERS). Their output is labelled “Mock provider”. Never enable this in production.</Notice></CardBody>}
        </Card>
        <Card>
          <CardHeader title="Agency-shared AI providers" description="Used by workspaces that have no key of their own and allow agency providers. Keys are encrypted at rest and never shown again." />
          <CardBody className="space-y-5">
            <ActionForm action={addSharedProviderAction} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
              <Field label="Kind" htmlFor="kind"><Select id="kind" name="kind"><option value="llm">Language model</option><option value="transcription">Transcription</option></Select></Field>
              <Field label="Provider" htmlFor="provider"><Select id="provider" name="provider"><option value="anthropic">Anthropic (LLM)</option><option value="openai">OpenAI (LLM or Whisper)</option><option value="deepgram">Deepgram (transcription)</option>{env.mockProviders() && <option value="mock">Mock (tests only)</option>}</Select></Field>
              <Field label="Label" htmlFor="label"><Input id="label" name="label" placeholder="Agency Anthropic" /></Field>
              <Field label="Model override (optional)" htmlFor="model"><Input id="model" name="model" placeholder="Uses the blueprint's preference" /></Field>
              <Field label="API key" htmlFor="apiKey" className="sm:col-span-2"><Input id="apiKey" name="apiKey" type="password" autoComplete="off" /></Field>
              <div className="sm:col-span-2"><SubmitButton>Add provider</SubmitButton></div>
            </ActionForm>
            {shared.length === 0 ? <EmptyState compact icon="plug" title="No shared providers" /> : (
              <ul className="divide-y divide-[var(--border)] rounded-[var(--radius-field)] border border-[var(--border)]">
                {shared.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
                    <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">{c.label} <span className="text-[var(--text-muted)]">· {c.provider} {c.kind}</span></div><div className="text-[12px] text-[var(--text-muted)]">key {c.externalAccountName} · checked <Timestamp value={c.lastCheckedAt} />{c.lastError ? ` · ${c.lastError}` : ""}</div></div>
                    <StatusBadge status={c.status} />
                    <ActionForm action={testSharedProviderAction} showErrorBanner={false}><input type="hidden" name="id" value={c.id} /><SubmitButton size="sm" variant="secondary">Test</SubmitButton></ActionForm>
                    <ActionForm action={removeSharedProviderAction} showErrorBanner={false}><input type="hidden" name="id" value={c.id} /><ConfirmSubmit title="Remove provider?" description="The stored key is destroyed. Workspaces relying on it will show a setup message." confirmLabel="Remove">Remove</ConfirmSubmit></ActionForm>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
