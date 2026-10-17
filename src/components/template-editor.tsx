"use client";

import * as React from "react";
import type { AgentConfig } from "@/lib/blueprint/schema";
import { cn } from "@/lib/utils";
import { ActionForm, SubmitButton } from "./ui/action-form";
import { Checkbox, Field, Input, Label, Select, Textarea } from "./ui/field";
import { Badge } from "./ui/kit";

type Props = { action: React.ComponentProps<typeof ActionForm>["action"]; id: string; name: string; description: string; config: AgentConfig; nodeLabels: Record<string, string> };

const TABS = ["Modules", "Instructions", "Models", "Editing", "Publishing & SEO", "Workflows", "Integrations", "Advanced JSON"] as const;

/**
 * Structured editor over the full agent config. Every tab edits the same JSON
 * document; "Advanced JSON" exposes all of it. The server validates the result
 * (schema, consistency, workflow graph, secret scan) on save.
 */
export function TemplateEditor({ action, id, name, description, config: initial, nodeLabels }: Props) {
  const [cfg, setCfg] = React.useState<AgentConfig>(initial);
  const [tab, setTab] = React.useState<(typeof TABS)[number]>("Modules");
  const [json, setJson] = React.useState(() => JSON.stringify(initial, null, 2));
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const update = (fn: (c: AgentConfig) => void) => setCfg((prev) => { const next = structuredClone(prev); fn(next); setJson(JSON.stringify(next, null, 2)); return next; });
  const m = cfg.modules;

  return (
    <ActionForm action={action} className="space-y-5">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="config" value={tab === "Advanced JSON" ? json : JSON.stringify(cfg)} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Template name" htmlFor="tname"><Input id="tname" name="name" defaultValue={name} required /></Field>
        <Field label="Description" htmlFor="tdesc"><Input id="tdesc" name="description" defaultValue={description} /></Field>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]" role="tablist">
        {TABS.map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t}
            onClick={() => {
              if (tab === "Advanced JSON" && t !== tab) {
                try { setCfg(JSON.parse(json)); setJsonError(null); } catch { setJsonError("Fix the JSON before switching tabs."); return; }
              }
              setTab(t);
            }}
            className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium", tab === t ? "border-[var(--brand)] text-[var(--text)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]")}>{t}</button>
        ))}
      </div>

      {tab === "Modules" && (
        <div className="grid gap-5 md:grid-cols-3">
          <ModuleCard title="Channel intelligence & ideation" enabled={m.ideation.enabled} onToggle={(v) => update((c) => { c.modules.ideation.enabled = v; })}>
            <Field label="Ideas per batch" htmlFor="bs"><Input id="bs" type="number" min={1} max={30} value={m.ideation.batchSize} onChange={(e) => update((c) => { c.modules.ideation.batchSize = Number(e.target.value); })} /></Field>
            <Field label="Automatic channel refresh" htmlFor="rf"><Select id="rf" value={m.ideation.refresh} onChange={(e) => update((c) => { c.modules.ideation.refresh = e.target.value as "manual"; })}><option value="manual">Manual</option><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></Field>
            <Checkbox label="Include Shorts repurposing ideas" checked={m.ideation.includeShortsIdeas} onChange={(e) => update((c) => { c.modules.ideation.includeShortsIdeas = e.target.checked; })} />
          </ModuleCard>
          <ModuleCard title="Raw-footage editor" enabled={m.editing.enabled} onToggle={(v) => update((c) => { c.modules.editing.enabled = v; })}>
            <Field label="Editing mode" htmlFor="em" hint="New clients default to review-first.">
              <Select id="em" value={m.editing.mode} onChange={(e) => update((c) => { c.modules.editing.mode = e.target.value as "review_first"; })}>
                <option value="assisted">Assisted — approve each change</option><option value="review_first">Review-first — draft cut, approve before export</option><option value="automatic">Automatic — apply approved rules</option>
              </Select>
            </Field>
          </ModuleCard>
          <ModuleCard title="Publishing" enabled={m.publishing.enabled} onToggle={(v) => update((c) => { c.modules.publishing.enabled = v; })}>
            <Field label="Mode" htmlFor="pm">
              <Select id="pm" value={m.publishing.mode} onChange={(e) => update((c) => { c.modules.publishing.mode = e.target.value as "approval"; })}>
                <option value="manual">Manual</option><option value="approval">Approval-based (default)</option><option value="rule_based">Rule-based (needs owner authorisation)</option>
              </Select>
            </Field>
            <Field label="Default visibility" htmlFor="pv"><Select id="pv" value={m.publishing.defaultPrivacy} onChange={(e) => update((c) => { c.modules.publishing.defaultPrivacy = e.target.value as "private"; })}><option value="private">Private</option><option value="unlisted">Unlisted</option><option value="public">Public</option></Select></Field>
          </ModuleCard>
          <div className="md:col-span-3">
            <Label>Approval gates</Label>
            <div className="mt-2 flex flex-wrap gap-5">
              {(Object.keys(cfg.approvalGates) as (keyof AgentConfig["approvalGates"])[]).map((k) => (
                <Checkbox key={k} label={{ ideas: "Idea batches", editPlan: "Edit plan", finalRender: "Final render", publish: "Publishing" }[k]} checked={cfg.approvalGates[k]} onChange={(e) => update((c) => { c.approvalGates[k] = e.target.checked; })} />
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "Instructions" && (
        <div className="space-y-4">
          <p className="text-[13px] text-[var(--text-muted)]">Agent instructions are reusable logic. Never put client names, account details or keys here — exports scan for them and refuse.</p>
          {(Object.keys(cfg.instructions) as (keyof AgentConfig["instructions"])[]).map((k) => (
            <Field key={k} label={{ system: "System prompt (all tasks)", channelAnalysis: "Channel analysis", ideation: "Content ideation", editing: "Editing / highlight picking", metadata: "Metadata & SEO" }[k]} htmlFor={`i-${k}`}>
              <Textarea id={`i-${k}`} rows={k === "system" ? 5 : 3} value={cfg.instructions[k]} onChange={(e) => update((c) => { c.instructions[k] = e.target.value; })} />
            </Field>
          ))}
        </div>
      )}

      {tab === "Models" && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-3">
            <Label>Language model preference (first configured wins)</Label>
            {cfg.models.llm.preferences.map((p, i) => (
              <div key={i} className="flex gap-2">
                <Select value={p.provider} onChange={(e) => update((c) => { c.models.llm.preferences[i].provider = e.target.value as "anthropic"; })} className="w-36"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option></Select>
                <Input value={p.model} onChange={(e) => update((c) => { c.models.llm.preferences[i].model = e.target.value; })} />
              </div>
            ))}
            <Field label="Effort" htmlFor="eff"><Select id="eff" value={cfg.models.llm.effort} onChange={(e) => update((c) => { c.models.llm.effort = e.target.value as "medium"; })}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select></Field>
          </div>
          <div className="space-y-3">
            <Label>Transcription preference</Label>
            {cfg.models.transcription.preferences.map((p, i) => (
              <div key={i} className="flex gap-2">
                <Select value={p.provider} onChange={(e) => update((c) => { c.models.transcription.preferences[i].provider = e.target.value as "openai"; })} className="w-36"><option value="openai">OpenAI</option><option value="deepgram">Deepgram</option></Select>
                <Input value={p.model} onChange={(e) => update((c) => { c.models.transcription.preferences[i].model = e.target.value; })} />
              </div>
            ))}
            <Checkbox label="Speaker diarisation (Deepgram only)" checked={cfg.models.transcription.diarization} onChange={(e) => update((c) => { c.models.transcription.diarization = e.target.checked; })} />
          </div>
        </div>
      )}

      {tab === "Editing" && (
        <div className="grid gap-5 md:grid-cols-3">
          <Field label="Pause threshold (s)" htmlFor="pt"><Input id="pt" type="number" step="0.1" value={m.editing.rules.pauseThresholdSeconds} onChange={(e) => update((c) => { c.modules.editing.rules.pauseThresholdSeconds = Number(e.target.value); })} /></Field>
          <Field label="Padding kept at cuts (s)" htmlFor="pp"><Input id="pp" type="number" step="0.05" value={m.editing.rules.pausePaddingSeconds} onChange={(e) => update((c) => { c.modules.editing.rules.pausePaddingSeconds = Number(e.target.value); })} /></Field>
          <Field label="Silence level (dB)" htmlFor="nd"><Input id="nd" type="number" value={m.editing.rules.silenceNoiseDb} onChange={(e) => update((c) => { c.modules.editing.rules.silenceNoiseDb = Number(e.target.value); })} /></Field>
          <Field label="Filler words" htmlFor="fw" className="md:col-span-2"><Input id="fw" value={m.editing.rules.fillerWords.join(", ")} onChange={(e) => update((c) => { c.modules.editing.rules.fillerWords = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></Field>
          <div className="space-y-2 pt-6">
            <Checkbox label="Remove pauses" checked={m.editing.rules.removePauses} onChange={(e) => update((c) => { c.modules.editing.rules.removePauses = e.target.checked; })} />
            <Checkbox label="Remove filler words" checked={m.editing.rules.removeFillerWords} onChange={(e) => update((c) => { c.modules.editing.rules.removeFillerWords = e.target.checked; })} />
            <Checkbox label="Remove repeated takes" checked={m.editing.rules.removeRepeats} onChange={(e) => update((c) => { c.modules.editing.rules.removeRepeats = e.target.checked; })} />
          </div>
          <Field label="Noise reduction" htmlFor="nr"><Select id="nr" value={m.editing.audio.noiseReduction} onChange={(e) => update((c) => { c.modules.editing.audio.noiseReduction = e.target.value as "off"; })}><option value="off">Off</option><option value="light">Light</option><option value="medium">Medium</option><option value="strong">Strong</option></Select></Field>
          <Field label="Loudness target (LUFS)" htmlFor="lufs"><Input id="lufs" type="number" value={m.editing.audio.targetLufs} onChange={(e) => update((c) => { c.modules.editing.audio.targetLufs = Number(e.target.value); })} /></Field>
          <Field label="Transitions" htmlFor="tr"><Select id="tr" value={m.editing.transitions.type} onChange={(e) => update((c) => { c.modules.editing.transitions.type = e.target.value as "none"; })}><option value="none">Hard cuts</option><option value="fade">Short fades</option></Select></Field>
          <div className="space-y-2">
            <Checkbox label="Captions" checked={m.editing.captions.enabled} onChange={(e) => update((c) => { c.modules.editing.captions.enabled = e.target.checked; })} />
            <Checkbox label="Burn captions into the video" checked={m.editing.captions.burnIn} onChange={(e) => update((c) => { c.modules.editing.captions.burnIn = e.target.checked; })} />
          </div>
          <div className="space-y-2">
            <Checkbox label="Overlay the client's logo" checked={m.editing.branding.useLogo} onChange={(e) => update((c) => { c.modules.editing.branding.useLogo = e.target.checked; })} />
            <Checkbox label="Prepend the client's intro" checked={m.editing.branding.useIntro} onChange={(e) => update((c) => { c.modules.editing.branding.useIntro = e.target.checked; })} />
            <Checkbox label="Append the client's outro" checked={m.editing.branding.useOutro} onChange={(e) => update((c) => { c.modules.editing.branding.useOutro = e.target.checked; })} />
          </div>
          <Field label="Shorts aspect / reframing" htmlFor="sa">
            <Select id="sa" value={`${m.editing.shorts.aspect}|${m.editing.shorts.reframe}`} onChange={(e) => update((c) => { const [a, r] = e.target.value.split("|"); c.modules.editing.shorts.aspect = a as "9:16"; c.modules.editing.shorts.reframe = r as "center_crop"; })}>
              <option value="9:16|center_crop">9:16, centre crop</option><option value="9:16|blur_pad">9:16, blurred background</option><option value="1:1|center_crop">1:1, centre crop</option><option value="1:1|blur_pad">1:1, blurred background</option>
            </Select>
          </Field>
          <div className="md:col-span-3">
            <Label>Render presets</Label>
            <div className="mt-2 flex flex-wrap gap-2">{cfg.renderPresets.map((p) => <Badge key={p.id}>{p.label} · {p.width}×{p.height} · CRF {p.crf}</Badge>)}</div>
            <p className="mt-1.5 text-[12px] text-[var(--text-muted)]">Add or change presets in Advanced JSON.</p>
          </div>
        </div>
      )}

      {tab === "Publishing & SEO" && (
        <div className="grid gap-5 md:grid-cols-3">
          <Field label="Title options" htmlFor="to"><Input id="to" type="number" min={1} max={10} value={cfg.seo.titleOptions} onChange={(e) => update((c) => { c.seo.titleOptions = Number(e.target.value); })} /></Field>
          <Field label="Max title length" htmlFor="mt"><Input id="mt" type="number" min={30} max={100} value={cfg.seo.maxTitleChars} onChange={(e) => update((c) => { c.seo.maxTitleChars = Number(e.target.value); })} /></Field>
          <Field label="Max tags / hashtags" htmlFor="mh"><div className="flex gap-2"><Input id="mh" type="number" value={cfg.seo.maxTags} onChange={(e) => update((c) => { c.seo.maxTags = Number(e.target.value); })} /><Input type="number" value={cfg.seo.maxHashtags} onChange={(e) => update((c) => { c.seo.maxHashtags = Number(e.target.value); })} /></div></Field>
          <Field label="Description template" htmlFor="dt" className="md:col-span-3" hint="Placeholders: {{summary}} {{chapters}} {{cta}} {{hashtags}}"><Textarea id="dt" rows={4} value={cfg.seo.descriptionTemplate} onChange={(e) => update((c) => { c.seo.descriptionTemplate = e.target.value; })} /></Field>
          <Field label="Call-to-action guidance" htmlFor="cta" className="md:col-span-2"><Input id="cta" value={cfg.seo.ctaGuidance} onChange={(e) => update((c) => { c.seo.ctaGuidance = e.target.value; })} /></Field>
          <Field label="Banned phrases" htmlFor="bp"><Input id="bp" value={cfg.seo.bannedPhrases.join(", ")} onChange={(e) => update((c) => { c.seo.bannedPhrases = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); })} /></Field>
          <div className="space-y-2">
            <Checkbox label="Include chapters" checked={cfg.seo.includeChapters} onChange={(e) => update((c) => { c.seo.includeChapters = e.target.checked; })} />
            <Checkbox label="Upload captions (needs youtube.force-ssl)" checked={m.publishing.uploadCaptions} onChange={(e) => update((c) => { c.modules.publishing.uploadCaptions = e.target.checked; })} />
          </div>
        </div>
      )}

      {tab === "Workflows" && (
        <div className="space-y-5">
          {cfg.workflows.map((wf) => (
            <div key={wf.key} className="rounded-[var(--radius-card)] border border-[var(--border)] p-4">
              <div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{wf.name}</span><Badge>{wf.key}</Badge><Badge tone="info">{wf.trigger.type}{wf.trigger.value ? `: ${wf.trigger.value}` : ""}</Badge></div>
              <p className="mt-1 text-[13px] text-[var(--text-muted)]">{wf.description}</p>
              <ol className="mt-3 space-y-1.5">
                {wf.nodes.map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                    <code className="mono rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[12px]">{n.id}</code>
                    <span className="font-medium">{n.label ?? nodeLabels[n.type] ?? n.type}</span>
                    {n.dependsOn.length > 0 && <span className="text-[var(--text-subtle)]">after {n.dependsOn.join(", ")}</span>}
                    {n.when && <Badge tone="warning" title={JSON.stringify(n.when)}>conditional</Badge>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
          <p className="text-[12.5px] text-[var(--text-muted)]">Edit workflow graphs in Advanced JSON. Only registered node types are accepted; conditions are declarative (no code).</p>
        </div>
      )}

      {tab === "Integrations" && (
        <div className="space-y-4">
          <div className="table-wrap"><table className="table-cl">
            <thead><tr><th>Logical reference</th><th>Kind</th><th>Required</th><th>Scopes</th><th>Purpose</th></tr></thead>
            <tbody>{cfg.integrations.map((i) => <tr key={i.ref}><td className="mono">{i.ref}</td><td>{i.kind}</td><td>{i.required ? "yes" : "no"}</td><td className="text-[12px]">{i.scopes?.join(", ") ?? "—"}</td><td className="text-[12.5px] text-[var(--text-muted)]">{i.purpose}</td></tr>)}</tbody>
          </table></div>
          <div className="table-wrap"><table className="table-cl">
            <thead><tr><th>Environment variable</th><th>Required</th><th>Secret</th><th>Description</th></tr></thead>
            <tbody>{cfg.env.map((e) => <tr key={e.name}><td className="mono">{e.name}</td><td>{e.required ? "yes" : "no"}</td><td>{e.secret ? "yes (name only)" : "no"}</td><td className="text-[12.5px] text-[var(--text-muted)]">{e.description}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}

      {tab === "Advanced JSON" && (
        <div>
          <Textarea aria-label="Agent configuration JSON" className="mono min-h-[520px] text-[12.5px]" value={json} spellCheck={false}
            onChange={(e) => { setJson(e.target.value); try { JSON.parse(e.target.value); setJsonError(null); } catch (err) { setJsonError((err as Error).message); } }} />
          {jsonError && <p className="mt-1.5 text-[12px] text-[var(--danger)]">{jsonError}</p>}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-[var(--border)] pt-4">
        <SubmitButton disabled={Boolean(jsonError)} pendingLabel="Validating…">Save draft</SubmitButton>
        <span className="text-[12.5px] text-[var(--text-muted)]">Saving validates the schema, workflow graph and secret scan. Deployments are unaffected until you publish and apply a version.</span>
      </div>
    </ActionForm>
  );
}

function ModuleCard({ title, enabled, onToggle, children }: { title: string; enabled: boolean; onToggle: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-3 rounded-[var(--radius-card)] border p-4", enabled ? "border-[var(--brand-border)]" : "border-[var(--border)] opacity-80")}>
      <Checkbox label={<span className="font-semibold">{title}</span>} checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
      {enabled && children}
    </div>
  );
}
