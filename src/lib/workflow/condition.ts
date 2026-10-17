import { z } from "zod";

/**
 * A tiny declarative condition language for workflow branching.
 *
 * Conditions are data, never code: a path into a fixed scope plus a
 * comparison. Paths may only start at `config`, `input` or `steps`, and only
 * plain own-property segments are followed — `__proto__`, `constructor` and
 * friends are refused — so an imported blueprint cannot reach anything else.
 */

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { path: string; op: "eq" | "neq" | "in" | "exists" | "gt" | "lt" | "truthy"; value?: unknown };

const PATH_RE = /^(config|input|steps)(\.[A-Za-z0-9_]+){0,8}$/;
const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(20) }).strict(),
    z.object({ not: conditionSchema }).strict(),
    z.object({
      path: z.string().regex(PATH_RE, "Condition paths must start with config., input. or steps."),
      op: z.enum(["eq", "neq", "in", "exists", "gt", "lt", "truthy"]),
      value: z.union([z.string().max(200), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(50)]).optional(),
    }).strict(),
  ]),
);

export type ConditionScope = { config: unknown; input: unknown; steps: Record<string, { output?: unknown; status?: string }> };

export function readPath(scope: ConditionScope, path: string): unknown {
  if (!PATH_RE.test(path)) return undefined;
  const parts = path.split(".");
  let cur: unknown = scope;
  for (const p of parts) {
    if (FORBIDDEN.has(p)) return undefined;
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function evaluate(cond: Condition, scope: ConditionScope, depth = 0): boolean {
  if (depth > 16) throw new Error("Condition nested too deeply.");
  if ("all" in cond) return cond.all.every((c) => evaluate(c, scope, depth + 1));
  if ("any" in cond) return cond.any.some((c) => evaluate(c, scope, depth + 1));
  if ("not" in cond) return !evaluate(cond.not, scope, depth + 1);
  const v = readPath(scope, cond.path);
  switch (cond.op) {
    case "exists": return v !== undefined && v !== null;
    case "truthy": return Boolean(v);
    case "eq": return v === cond.value;
    case "neq": return v !== cond.value;
    case "in": return Array.isArray(cond.value) && (cond.value as unknown[]).includes(v);
    case "gt": return typeof v === "number" && typeof cond.value === "number" && v > cond.value;
    case "lt": return typeof v === "number" && typeof cond.value === "number" && v < cond.value;
  }
}
