import { createHash } from "node:crypto";
import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped } from "fflate";
import { z } from "zod";
import { validateWorkflow, workflowRequirements, type WorkflowIssue } from "../workflow/definition";
import { nodeSpec } from "../workflow/nodes";
import { canonicalJson } from "./diff";
import { renderReadme, renderEnvExample, renderIntegrations, summarizeBlueprint } from "./readme";
import { scanForSecrets, type ScanFinding } from "./scan";
import {
  APP_VERSION, BLUEPRINT_FORMAT, MIN_SUPPORTED_SCHEMA, SCHEMA_VERSION, blueprintSchema, compareSemver,
  type AgentConfig, type Blueprint,
} from "./schema";

export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_UNZIPPED_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 200;

export function buildBlueprint(meta: { uid: string; name: string; description: string; version: string; changelog?: string; createdAt?: Date }, config: AgentConfig): Blueprint {
  return blueprintSchema.parse({
    format: BLUEPRINT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    blueprint: {
      uid: meta.uid, name: meta.name, description: meta.description, version: meta.version,
      changelog: meta.changelog ?? "", createdAt: (meta.createdAt ?? new Date()).toISOString(),
    },
    compatibility: { minAppVersion: APP_VERSION, schemaVersion: SCHEMA_VERSION },
    config,
  });
}

export function contentHash(bp: Blueprint): string {
  return createHash("sha256").update(canonicalJson(bp)).digest("hex");
}

/* ── validation ───────────────────────────────────────────────────────── */

export type ValidationReport = {
  ok: boolean;
  blueprint?: Blueprint;
  errors: string[];
  warnings: string[];
  secrets: ScanFinding[];
  workflowIssues: (WorkflowIssue & { workflow: string })[];
  compatibility: { schemaVersion?: string; minAppVersion?: string; appVersion: string; compatible: boolean; reason?: string };
  requirements: {
    integrations: { ref: string; kind: string; required: boolean; scopes?: string[] }[];
    env: { name: string; required: boolean; secret: boolean }[];
    capabilities: string[];
  };
};

/**
 * Validates an untrusted blueprint document. Nothing in it is executed:
 * workflow node types must exist in this build's registry and conditions are
 * a closed data language. Any secret-like value fails validation outright.
 */
export function validateBlueprintDocument(raw: unknown): ValidationReport {
  const report: ValidationReport = {
    ok: false, errors: [], warnings: [], secrets: [], workflowIssues: [],
    compatibility: { appVersion: APP_VERSION, compatible: false },
    requirements: { integrations: [], env: [], capabilities: [] },
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    report.errors.push("The file is not a JSON object.");
    return report;
  }
  const r = raw as Record<string, unknown>;
  if (r.format !== BLUEPRINT_FORMAT) {
    report.errors.push(`Not a Cutline blueprint (format must be "${BLUEPRINT_FORMAT}").`);
    return report;
  }

  // Compatibility first, so an incompatible file gets a clear reason rather than schema noise.
  const sv = typeof r.schemaVersion === "string" ? r.schemaVersion : undefined;
  const compat = (r.compatibility ?? {}) as Record<string, unknown>;
  const minApp = typeof compat.minAppVersion === "string" ? compat.minAppVersion : undefined;
  report.compatibility.schemaVersion = sv;
  report.compatibility.minAppVersion = minApp;
  const semverRe = /^\d+\.\d+\.\d+$/;
  if (!sv || !semverRe.test(sv)) report.compatibility.reason = "Missing or invalid schemaVersion.";
  else if (sv.split(".")[0] !== SCHEMA_VERSION.split(".")[0]) report.compatibility.reason = `Schema ${sv} is a different major version from this installation's ${SCHEMA_VERSION}.`;
  else if (compareSemver(sv, MIN_SUPPORTED_SCHEMA) < 0) report.compatibility.reason = `Schema ${sv} is older than the oldest supported (${MIN_SUPPORTED_SCHEMA}).`;
  else if (compareSemver(sv, SCHEMA_VERSION) > 0) report.compatibility.reason = `Schema ${sv} is newer than this installation supports (${SCHEMA_VERSION}). Upgrade the application first.`;
  else if (minApp && semverRe.test(minApp) && compareSemver(minApp, APP_VERSION) > 0) report.compatibility.reason = `Requires application ${minApp} or later; this is ${APP_VERSION}.`;
  else report.compatibility.compatible = true;
  if (!report.compatibility.compatible) report.errors.push(report.compatibility.reason!);

  report.secrets = scanForSecrets(raw);
  if (report.secrets.length) {
    report.errors.push(`The blueprint contains ${report.secrets.length} value(s) that look like credentials or private data. Remove them; blueprints reference secrets by environment-variable name only.`);
  }

  // Unknown node types are reported per node (clearer than a generic schema error).
  const wfs = ((r.config as Record<string, unknown> | undefined)?.workflows ?? []) as unknown[];
  if (Array.isArray(wfs)) {
    for (const wf of wfs) {
      const nodes = (wf as { nodes?: unknown[] })?.nodes;
      if (!Array.isArray(nodes)) continue;
      for (const n of nodes) {
        const t = (n as { type?: unknown })?.type;
        if (typeof t === "string" && !nodeSpec(t)) {
          report.workflowIssues.push({ workflow: String((wf as { key?: unknown }).key ?? "?"), level: "error", node: String((n as { id?: unknown }).id ?? "?"), message: `Unsupported node type "${t}".` });
        }
      }
    }
  }

  const parsed = blueprintSchema.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 40)) report.errors.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
    report.ok = false;
    return report;
  }

  const bp = parsed.data;
  report.blueprint = bp;
  report.requirements = {
    integrations: bp.config.integrations.map((i) => ({ ref: i.ref, kind: i.kind, required: i.required, scopes: i.scopes })),
    env: bp.config.env.map((e) => ({ name: e.name, required: e.required, secret: e.secret })),
    capabilities: bp.config.capabilities,
  };
  report.errors.push(...configConsistency(bp.config));

  for (const wf of bp.config.workflows) {
    for (const issue of validateWorkflow(wf)) {
      if (!report.workflowIssues.some((x) => x.workflow === wf.key && x.node === issue.node && x.message === issue.message)) {
        report.workflowIssues.push({ ...issue, workflow: wf.key });
      }
    }
    const declared = new Set(bp.config.integrations.map((i) => i.kind));
    for (const kind of workflowRequirements(wf)) {
      if (!declared.has(kind)) report.errors.push(`Workflow "${wf.key}" needs a ${kind} integration but the blueprint does not declare one.`);
    }
  }
  for (const wi of report.workflowIssues) (wi.level === "error" ? report.errors : report.warnings).push(`Workflow ${wi.workflow}${wi.node ? ` / ${wi.node}` : ""}: ${wi.message}`);

  report.ok = report.errors.length === 0;
  return report;
}

/** Cross-field rules the schema cannot express. */
export function configConsistency(c: AgentConfig): string[] {
  const errors: string[] = [];
  const presetIds = new Set(c.renderPresets.map((p) => p.id));
  if (presetIds.size !== c.renderPresets.length) errors.push("Render preset ids must be unique.");
  for (const [k, id] of Object.entries(c.modules.editing.presets)) {
    if (!presetIds.has(id)) errors.push(`modules.editing.presets.${k} refers to unknown render preset "${id}".`);
  }
  const keys = new Set<string>();
  for (const wf of c.workflows) {
    if (keys.has(wf.key)) errors.push(`Duplicate workflow key "${wf.key}".`);
    keys.add(wf.key);
  }
  const refs = new Set<string>();
  for (const i of c.integrations) {
    if (refs.has(i.ref)) errors.push(`Duplicate integration ref "${i.ref}".`);
    refs.add(i.ref);
  }
  const names = new Set<string>();
  for (const e of c.env) {
    if (names.has(e.name)) errors.push(`Duplicate environment variable "${e.name}".`);
    names.add(e.name);
  }
  if (c.modules.publishing.enabled && !c.integrations.some((i) => i.kind === "youtube" && i.scopes?.includes("youtube.upload"))) {
    errors.push("Publishing is enabled but no YouTube integration requests the youtube.upload scope.");
  }
  return errors;
}

/* ── packaging ────────────────────────────────────────────────────────── */

export type PackageFile = { path: string; content: string };

export function blueprintJsonSchema(): unknown {
  try {
    return z.toJSONSchema(blueprintSchema, { unrepresentable: "any", io: "input" });
  } catch {
    return { note: "JSON Schema generation unavailable; validate with `npm run blueprint:validate`." };
  }
}

/** Exactly the files a ZIP export will contain — also what the export preview shows. */
export function packageFiles(bp: Blueprint): PackageFile[] {
  const files: PackageFile[] = [
    { path: "blueprint.json", content: JSON.stringify(bp, null, 2) },
    { path: "schema/blueprint.schema.json", content: JSON.stringify(blueprintJsonSchema(), null, 2) },
    ...bp.config.workflows.map((wf) => ({ path: `workflows/${wf.key}.json`, content: JSON.stringify(wf, null, 2) })),
    { path: "config/render-presets.json", content: JSON.stringify(bp.config.renderPresets, null, 2) },
    { path: "config/modules.json", content: JSON.stringify(bp.config.modules, null, 2) },
    { path: "README.md", content: renderReadme(bp) },
    { path: "INTEGRATIONS.md", content: renderIntegrations(bp) },
    { path: ".env.example", content: renderEnvExample(bp) },
    { path: "VERSION", content: `blueprint ${bp.blueprint.version}\nschema ${bp.schemaVersion}\nmin-app ${bp.compatibility.minAppVersion}\n` },
  ];
  const manifest = {
    format: `${BLUEPRINT_FORMAT}.package`,
    packageVersion: 1,
    blueprint: { uid: bp.blueprint.uid, name: bp.blueprint.name, version: bp.blueprint.version },
    schemaVersion: bp.schemaVersion,
    createdAt: new Date().toISOString(),
    summary: summarizeBlueprint(bp),
    files: files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content), sha256: sha256(f.content) })),
  };
  return [{ path: "manifest.json", content: JSON.stringify(manifest, null, 2) }, ...files];
}

export function packageZip(bp: Blueprint): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of packageFiles(bp)) entries[f.path] = strToU8(f.content);
  return zipSync(entries, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
}

/**
 * Reads an uploaded .json or .zip package into a raw blueprint object plus any
 * package-level problems (bad paths, checksum mismatch). The result still has
 * to pass validateBlueprintDocument.
 */
export function readPackage(bytes: Uint8Array, filename: string): { raw?: unknown; problems: string[] } {
  const problems: string[] = [];
  if (bytes.byteLength > MAX_PACKAGE_BYTES) return { problems: [`Package is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024} MB.`] };

  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    if (!/\.json$/i.test(filename)) problems.push("Expected a .json or .zip file.");
    try {
      return { raw: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), problems };
    } catch {
      return { problems: ["The file is not valid UTF-8 JSON."] };
    }
  }

  let files: Unzipped;
  let total = 0, count = 0;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > MAX_FILES) throw new Error("too many files");
        if (total > MAX_UNZIPPED_BYTES) throw new Error("uncompressed size too large");
        if (!safeZipPath(f.name)) throw new Error(`unsafe path "${f.name}"`);
        return true;
      },
    });
  } catch (e) {
    return { problems: [`Could not read ZIP: ${e instanceof Error ? e.message : "invalid archive"}.`] };
  }

  const blueprintFile = files["blueprint.json"];
  if (!blueprintFile) return { problems: ["The ZIP has no blueprint.json at its root."] };

  const manifestFile = files["manifest.json"];
  if (!manifestFile) problems.push("manifest.json is missing; file integrity could not be verified.");
  else {
    try {
      const manifest = JSON.parse(strFromU8(manifestFile)) as { files?: { path: string; sha256: string }[] };
      for (const entry of manifest.files ?? []) {
        const f = files[entry.path];
        if (!f) problems.push(`Manifest lists ${entry.path} but it is missing.`);
        else if (sha256(f) !== entry.sha256) problems.push(`Checksum mismatch for ${entry.path} — the package was modified after export.`);
      }
    } catch {
      problems.push("manifest.json is not valid JSON.");
    }
  }

  try {
    return { raw: JSON.parse(strFromU8(blueprintFile)), problems };
  } catch {
    return { problems: [...problems, "blueprint.json is not valid JSON."] };
  }
}

function safeZipPath(name: string): boolean {
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name)) return false;
  return !name.split(/[\\/]/).some((seg) => seg === "..");
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
