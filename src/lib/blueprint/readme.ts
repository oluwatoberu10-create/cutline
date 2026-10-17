import { nodeSpec } from "../workflow/nodes";
import type { Blueprint } from "./schema";

/** One-paragraph human summary, shown in previews and the manifest. */
export function summarizeBlueprint(bp: Blueprint): string {
  const c = bp.config;
  const mods = [
    c.modules.ideation.enabled && "channel intelligence & ideation",
    c.modules.editing.enabled && `raw-footage editing (${c.modules.editing.mode.replace("_", "-")})`,
    c.modules.publishing.enabled && `YouTube publishing (${c.modules.publishing.mode.replace("_", "-")})`,
  ].filter(Boolean);
  return `${bp.blueprint.name} v${bp.blueprint.version}: ${mods.join(", ") || "no modules enabled"}. ` +
    `${c.workflows.length} workflow(s), ${c.renderPresets.length} render preset(s), ` +
    `requires ${c.integrations.filter((i) => i.required).map((i) => i.ref).join(", ") || "no integrations"}.`;
}

export function renderEnvExample(bp: Blueprint): string {
  const lines = [
    `# Environment for blueprint "${bp.blueprint.name}" v${bp.blueprint.version}`,
    "# Variable NAMES only. Fill values in your own deployment; never commit them.",
    "",
    "DATABASE_URL=",
    "CUTLINE_ENCRYPTION_KEY=",
    "CUTLINE_SIGNING_SECRET=",
    "APP_URL=",
    "",
  ];
  for (const e of bp.config.env) {
    if (["CUTLINE_ENCRYPTION_KEY", "CUTLINE_SIGNING_SECRET"].includes(e.name)) continue;
    lines.push(`# ${e.description}${e.required ? " (required)" : " (optional)"}`);
    lines.push(`${e.name}=${e.secret ? "" : e.example ?? ""}`);
  }
  return lines.join("\n") + "\n";
}

export function renderIntegrations(bp: Blueprint): string {
  const rows = bp.config.integrations.map((i) =>
    `| \`${i.ref}\` | ${i.kind} | ${i.required ? "yes" : "no"} | ${i.scopes?.map((s) => `\`${s}\``).join(", ") ?? "—"} | ${i.purpose} |`);
  return [
    "# Integration requirements",
    "",
    "Each logical reference is bound to the client's OWN connection at deployment time.",
    "",
    "| Reference | Kind | Required | OAuth scopes | Purpose |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "## Capabilities the installation must provide",
    "",
    ...bp.config.capabilities.map((c) => `- \`${c}\``),
    "",
  ].join("\n");
}

export function renderReadme(bp: Blueprint): string {
  const c = bp.config;
  const wf = c.workflows.map((w) => [
    `### ${w.name} (\`${w.key}\`)`,
    "",
    w.description,
    "",
    ...w.nodes.map((n) => `${n.dependsOn.length ? `- after ${n.dependsOn.join(", ")}: ` : "- "}**${n.label ?? nodeSpec(n.type)?.label ?? n.type}** (\`${n.type}\`)${n.when ? " — conditional" : ""}`),
    "",
  ].join("\n")).join("\n");

  return `# ${bp.blueprint.name}

Version ${bp.blueprint.version} · blueprint schema ${bp.schemaVersion} · requires Cutline ${bp.compatibility.minAppVersion}+

${bp.blueprint.description}

${summarizeBlueprint(bp)}

This package contains reusable agent logic only. It contains no API keys, OAuth tokens, passwords,
client footage, transcripts, analytics, personal data or storage URLs.

## Deploying this blueprint for a client

**Agency-managed installation**

1. Agency → Blueprint Library → Import → choose this ZIP (or blueprint.json). Review the validation report and confirm.
2. Agency → Deploy → pick the imported blueprint and the client's workspace.
3. Fill the client's profile (${c.requiredClientSettings.join(", ") || "no required fields"}).
4. Connect the client's own accounts for each integration below, run the checks, review the diff and activate.

**Client-owned installation**

1. Install Cutline ${bp.compatibility.minAppVersion}+ (see the application's DEPLOYMENT.md; Docker Compose provided).
2. Copy \`.env.example\` to \`.env\` and fill in the client's OWN credentials.
3. Run migrations, start the web app and the worker, create the first admin.
4. \`npm run blueprint:import -- ./this-package.zip\` or use the Import screen, then deploy as above.

## Integrations

${c.integrations.map((i) => `- \`${i.ref}\` (${i.kind}${i.required ? ", required" : ", optional"}) — ${i.purpose}`).join("\n")}

## Workflows

${wf}
## Behaviour summary

- Editing mode: **${c.modules.editing.mode}**; pause threshold ${c.modules.editing.rules.pauseThresholdSeconds}s; filler-word removal ${c.modules.editing.rules.removeFillerWords ? "on" : "off"}.
- Captions: ${c.modules.editing.captions.enabled ? (c.modules.editing.captions.burnIn ? "burned in" : "sidecar file") : "off"}.
- Publishing: ${c.modules.publishing.enabled ? `${c.modules.publishing.mode}, default visibility ${c.modules.publishing.defaultPrivacy}` : "disabled"}.
- Approval gates: ${Object.entries(c.approvalGates).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}.
- Retries: up to ${c.policies.retry.maxAttempts} attempts, ${c.policies.retry.backoffSeconds}s backoff.

## Render presets

${c.renderPresets.map((p) => `- \`${p.id}\` ${p.label}: ${p.width}×${p.height} @ ${p.fps}fps ${p.container}, CRF ${p.crf}`).join("\n")}
`;
}
