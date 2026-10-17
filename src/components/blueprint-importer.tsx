"use client";

import * as React from "react";
import type { ActionState } from "@/lib/action-state";
import { Button } from "./ui/button";
import { Checkbox, FormError } from "./ui/field";
import { Badge, Notice } from "./ui/kit";

type Plan = {
  action: "create_template" | "add_version" | "already_imported" | "version_conflict" | "invalid";
  contentHash: string | null;
  existingTemplate: { id: string; name: string } | null;
  packageProblems: string[];
  environment: { label: string; ok: boolean; detail: string }[];
  report: {
    ok: boolean; errors: string[]; warnings: string[];
    secrets: { path: string; rule: string; excerpt: string }[];
    compatibility: { schemaVersion?: string; minAppVersion?: string; appVersion: string; compatible: boolean; reason?: string };
    requirements: { integrations: { ref: string; kind: string; required: boolean; scopes?: string[] }[]; env: { name: string; required: boolean; secret: boolean }[]; capabilities: string[] };
    blueprint: { blueprint: { name: string; version: string; description: string; changelog: string }; schemaVersion: string } | null;
  };
};

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;

const ACTION_TEXT: Record<Plan["action"], string> = {
  create_template: "Creates a new agent template with this version. Nothing is deployed.",
  add_version: "Adds this version to the existing template. Deployments keep their current versions until you apply an update to each one.",
  already_imported: "This exact version is already in your library. Nothing will change.",
  version_conflict: "A different blueprint with this same version number exists. You can import it as a separate template.",
  invalid: "The package failed validation and cannot be imported.",
};

/** Step 1 validates and explains; step 2 imports the same file only after confirmation. */
export function BlueprintImporter({ preview, confirm }: { preview: Act; confirm: Act }) {
  const [file, setFile] = React.useState<File | null>(null);
  const [plan, setPlan] = React.useState<Plan | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [asNew, setAsNew] = React.useState(false);
  const [ack, setAck] = React.useState(false);

  const run = async (fn: Act, extra: Record<string, string> = {}) => {
    if (!file) return null;
    setBusy(true); setError(null);
    const fd = new FormData();
    fd.set("file", file);
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    try { const r = await fn({}, fd); if (!r.ok) setError(r.error ?? "Failed."); return r; }
    catch (e) { if ((e as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw e; setError("Request failed."); return null; }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input type="file" accept=".json,.zip,application/json,application/zip" aria-label="Blueprint file"
          onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPlan(null); setError(null); setAck(false); }}
          className="text-[13px] file:mr-3 file:rounded-[var(--radius-field)] file:border file:border-[var(--border)] file:bg-[var(--surface)] file:px-3 file:py-1.5 file:text-[13px] file:font-medium" />
        <Button type="button" variant="secondary" disabled={!file || busy} loading={busy && !plan}
          onClick={async () => { const r = await run(preview); if (r?.ok && typeof r.data?.plan === "string") setPlan(JSON.parse(r.data.plan)); }}>Validate</Button>
      </div>
      {error && <FormError>{error}</FormError>}
      {plan && <PlanView plan={plan} />}
      {plan && plan.action !== "invalid" && plan.action !== "already_imported" && (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-[var(--border)] p-4">
          {plan.action === "version_conflict" && <Checkbox label="Import as a separate template (new identity)" checked={asNew} onChange={(e) => setAsNew(e.target.checked)} />}
          <Checkbox label="I reviewed the report. Imported instructions and workflows are treated as untrusted configuration and nothing is activated." checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <Button type="button" disabled={!ack || busy || (plan.action === "version_conflict" && !asNew)} loading={busy}
            onClick={() => run(confirm, { contentHash: plan.contentHash!, asNewTemplate: asNew ? "on" : "" })}>Import</Button>
        </div>
      )}
    </div>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  const r = plan.report;
  const bp = r.blueprint?.blueprint;
  return (
    <div className="space-y-3">
      <Notice tone={plan.action === "invalid" ? "danger" : plan.action === "version_conflict" ? "warning" : "info"} title={bp ? `${bp.name} v${bp.version}` : "Validation report"}>
        {ACTION_TEXT[plan.action]}{plan.existingTemplate && <> Existing template: <strong>{plan.existingTemplate.name}</strong>.</>}
      </Notice>
      <div className="grid gap-3 md:grid-cols-2">
        <Box title="Compatibility">
          <div className="flex items-center gap-2">{r.compatibility.compatible ? <Badge tone="success">Compatible</Badge> : <Badge tone="danger">Incompatible</Badge>}<span className="text-[12.5px] text-[var(--text-muted)]">schema {r.compatibility.schemaVersion ?? "?"} · needs app {r.compatibility.minAppVersion ?? "?"} · this is {r.compatibility.appVersion}</span></div>
          {r.compatibility.reason && <p className="mt-1 text-[12.5px] text-[var(--danger)]">{r.compatibility.reason}</p>}
        </Box>
        <Box title="Secret & private-data scan">{r.secrets.length ? r.secrets.map((s) => <div key={s.path} className="text-[12.5px] text-[var(--danger)]">{s.path}: {s.rule} ({s.excerpt})</div>) : <Badge tone="success">No credentials or private data found</Badge>}</Box>
        <Box title="Required integrations (each client connects their own)">
          {r.requirements.integrations.map((i) => <div key={i.ref} className="text-[12.5px]"><code className="mono">{i.ref}</code> · {i.kind}{i.required ? "" : " (optional)"}{i.scopes ? ` · ${i.scopes.join(", ")}` : ""}</div>)}
        </Box>
        <Box title="This installation">
          {plan.environment.length ? plan.environment.map((e) => <div key={e.label} className="flex gap-2 text-[12.5px]"><Badge tone={e.ok ? "success" : "warning"}>{e.ok ? "ok" : "missing"}</Badge><span>{e.label}: <span className="text-[var(--text-muted)]">{e.detail}</span></span></div>) : <span className="text-[12.5px] text-[var(--text-muted)]">Not checked (package invalid).</span>}
        </Box>
      </div>
      {(r.errors.length > 0 || plan.packageProblems.length > 0) && <Notice tone="danger" title="Problems">{[...plan.packageProblems, ...r.errors].slice(0, 20).map((e) => <div key={e}>{e}</div>)}</Notice>}
      {r.warnings.length > 0 && <Notice tone="warning" title="Warnings">{r.warnings.map((e) => <div key={e}>{e}</div>)}</Notice>}
    </div>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="rounded-[var(--radius-field)] border border-[var(--border)] p-3"><div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-subtle)]">{title}</div>{children}</div>;
}
