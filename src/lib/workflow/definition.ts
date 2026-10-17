import { z } from "zod";
import { conditionSchema } from "./condition";
import { nodeSpec, type IntegrationKind } from "./nodes";

export const nodeIdRe = /^[a-z][a-z0-9_]{0,39}$/;

export const workflowNodeSchema = z.object({
  id: z.string().regex(nodeIdRe, "Node ids are lowercase letters, digits and underscores."),
  type: z.string().min(1).max(60),
  label: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string().regex(nodeIdRe)).max(20).default([]),
  when: conditionSchema.optional(),
}).strict();

export const workflowSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  trigger: z.object({
    type: z.enum(["manual", "schedule", "event"]),
    /** schedule: "daily" | "weekly"; event: "media.ready". */
    value: z.string().max(40).optional(),
  }).strict().default({ type: "manual" }),
  /** Which run-input keys a manual start must supply (e.g. "assetId"). */
  inputs: z.array(z.object({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), label: z.string().max(80), kind: z.enum(["media_asset", "content_idea", "text"]), required: z.boolean().default(true) }).strict()).max(10).default([]),
  nodes: z.array(workflowNodeSchema).min(1).max(40),
}).strict();

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowSchema>;

export type WorkflowIssue = { level: "error" | "warning"; node?: string; message: string };

/**
 * Structural validation beyond the schema: known node types, valid per-node
 * config, dependencies that exist, no cycles, `$from` references that point
 * at upstream steps. Returns every issue rather than stopping at the first.
 */
export function validateWorkflow(wf: WorkflowDefinition): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const ids = new Set<string>();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) issues.push({ level: "error", node: n.id, message: `Duplicate node id "${n.id}".` });
    ids.add(n.id);
  }

  for (const n of wf.nodes) {
    const spec = nodeSpec(n.type);
    if (!spec) {
      issues.push({ level: "error", node: n.id, message: `Unsupported node type "${n.type}". It is not part of this application's node registry.` });
      continue;
    }
    if (spec.deprecated) {
      issues.push({ level: "warning", node: n.id, message: `Node type "${n.type}" is deprecated since ${spec.deprecated.since}: ${spec.deprecated.note}` });
    }
    const parsed = spec.config.safeParse(n.config);
    if (!parsed.success) {
      issues.push({ level: "error", node: n.id, message: `Invalid config for ${n.type}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}` });
    }
    for (const d of n.dependsOn) {
      if (!ids.has(d)) issues.push({ level: "error", node: n.id, message: `Depends on unknown node "${d}".` });
      if (d === n.id) issues.push({ level: "error", node: n.id, message: "A node cannot depend on itself." });
    }
  }

  const order = topoSort(wf.nodes);
  if (!order) {
    issues.push({ level: "error", message: "The workflow contains a dependency cycle." });
    return issues;
  }

  // $from references must point at an ancestor (something guaranteed to have run).
  const ancestors = ancestorMap(wf.nodes);
  for (const n of wf.nodes) {
    for (const ref of collectRefs(n.config)) {
      const m = /^steps\.([a-z][a-z0-9_]*)\.output/.exec(ref);
      if (m && !ancestors.get(n.id)?.has(m[1])) {
        issues.push({ level: "error", node: n.id, message: `References steps.${m[1]} which is not an upstream dependency.` });
      }
    }
  }
  return issues;
}

export function topoSort(nodes: Pick<WorkflowNode, "id" | "dependsOn">[]): string[] | null {
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.dependsOn) {
    if (!indeg.has(d)) continue;
    indeg.set(n.id, (indeg.get(n.id) ?? 0) + 1);
    out.get(d)!.push(n.id);
  }
  const queue = [...indeg].filter(([, v]) => v === 0).map(([k]) => k);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const nx of out.get(id) ?? []) {
      indeg.set(nx, indeg.get(nx)! - 1);
      if (indeg.get(nx) === 0) queue.push(nx);
    }
  }
  return order.length === nodes.length ? order : null;
}

function ancestorMap(nodes: Pick<WorkflowNode, "id" | "dependsOn">[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const memo = new Map<string, Set<string>>();
  const visit = (id: string, stack: Set<string>): Set<string> => {
    if (memo.has(id)) return memo.get(id)!;
    const set = new Set<string>();
    if (stack.has(id)) return set;
    stack.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      set.add(d);
      for (const a of visit(d, stack)) set.add(a);
    }
    stack.delete(id);
    memo.set(id, set);
    return set;
  };
  for (const n of nodes) visit(n.id, new Set());
  return memo;
}

export function collectRefs(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, acc));
  else if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.$from === "string") acc.push(rec.$from);
    else Object.values(rec).forEach((v) => collectRefs(v, acc));
  }
  return acc;
}

/** Every integration kind any node of the workflow needs. */
export function workflowRequirements(wf: WorkflowDefinition): IntegrationKind[] {
  const set = new Set<IntegrationKind>();
  for (const n of wf.nodes) nodeSpec(n.type)?.requires.forEach((r) => set.add(r));
  return [...set];
}
