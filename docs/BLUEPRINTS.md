# Blueprint format (schema 1.0.0)

A blueprint is a portable, versioned JSON document describing **reusable agent logic**.
It never contains client data or secret values. See [sample-blueprint.json](sample-blueprint.json).

```jsonc
{
  "format": "cutline.blueprint",
  "schemaVersion": "1.0.0",
  "blueprint": { "uid": "<uuid>", "name": "…", "description": "…", "version": "1.2.0", "changelog": "…", "createdAt": "…" },
  "compatibility": { "minAppVersion": "1.0.0", "schemaVersion": "1.0.0" },
  "config": {
    "modules": { "ideation": {…}, "editing": {…}, "publishing": {…} },
    "instructions": { "system": "…", "channelAnalysis": "…", "ideation": "…", "editing": "…", "metadata": "…" },
    "models": { "llm": { "ref": "llm_provider", "preferences": [{ "provider": "anthropic", "model": "…" }], "effort": "medium" },
                "transcription": { "ref": "transcription_provider", "preferences": [{ "provider": "openai", "model": "whisper-1" }] } },
    "seo": {…}, "renderPresets": [{ "id": "final-1080p", "width": 1920, "height": 1080, … }],
    "approvalGates": { "ideas": true, "editPlan": true, "finalRender": true, "publish": true },
    "policies": { "retry": {…}, "timeouts": {…} },
    "workflows": [{ "key": "…", "trigger": { "type": "manual" }, "inputs": […], "nodes": [ … ] }],
    "integrations": [{ "ref": "youtube_connection", "kind": "youtube", "required": true, "scopes": ["youtube.readonly"], "purpose": "…" }],
    "env": [{ "name": "OPENAI_API_KEY", "required": false, "secret": true, "description": "…" }],
    "capabilities": ["ffmpeg", "ffprobe", "llm.structured_json", …],
    "requiredClientSettings": ["niche", "targetAudience", "tone"],
    "exampleClientSettings": { "niche": "Example: …" }
  }
}
```

Every object is validated strictly: unknown keys are rejected. The JSON Schema is included in
every ZIP (`schema/blueprint.schema.json`) and generated from the same definitions the app uses
(`src/lib/blueprint/schema.ts`).

## Workflows

Nodes are typed entries from a fixed registry (`src/lib/workflow/nodes.ts`):
`channel.sync`, `channel.analyze`, `ideas.generate`, `approval.gate`, `media.transcribe`,
`edit.propose`, `render.draft`, `render.final`, `metadata.generate`, `publish.upload`,
`publish.track`. Each declares its config schema, outputs, required integration kinds and
whether it has external side effects.

- `dependsOn` forms a DAG (cycles are rejected).
- `{ "$from": "input.assetId" }` / `{ "$from": "steps.propose.output.editProjectId" }` pass data;
  references must point at upstream steps.
- `when` is a declarative condition — `{path, op, value}` with `all`/`any`/`not` — over
  `config.*`, `input.*` and `steps.*` only. It cannot execute code or reach anything else.
- A node is **skipped** when its condition is false or when it consumes the output of a skipped step.
- `approval.gate` pauses the run until an owner decides; rejection fails the run (retry resumes it).

## Packages

| Format | Contents |
|---|---|
| JSON | `blueprint.json` only |
| ZIP | `manifest.json` (file list + SHA-256), `blueprint.json`, `schema/blueprint.schema.json`, `workflows/*.json`, `config/*.json`, `README.md`, `INTEGRATIONS.md`, `.env.example`, `VERSION` |
| Deployment kit | the ZIP plus `docker-compose.yml`, `DEPLOY.md`, `.env.example` for a client-owned install |

**Never included:** API keys, OAuth tokens, passwords, encryption keys, footage, transcripts,
captions, analytics, video lists, ideas, client names/emails/ids, storage paths, signed URLs,
deployment overrides or bindings. Every file is scanned for credential and private-data
patterns on export; any finding blocks the export.

## Import

1. Size, path-traversal and zip-bomb limits; manifest checksums verified.
2. Format, schema-version major and minimum app version checked (clear reason if incompatible).
3. Secret/private-data scan (a finding rejects the package; values are never echoed back).
4. Strict schema validation; unsupported or deprecated node types reported per node; DAG and `$from` checks.
5. A plan is shown: *create template*, *add version*, *already imported* or *version conflict*,
   plus which integrations each client must connect and what this installation provides.
6. Import requires confirmation against the previewed content hash. It creates a template or a
   new version only — no deployment or template draft is changed.

## Versioning, updates and rollback

- Publishing a template freezes its draft as an immutable `MAJOR.MINOR.PATCH` version.
- A deployment pins one version plus the client's overrides (only a defined set of settings may be overridden).
- New versions appear as *updates available*; the diff of the client's effective configuration is
  shown before applying. Applying records a revision; any revision can be restored exactly.
