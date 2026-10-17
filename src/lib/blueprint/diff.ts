/** Structural diff of two JSON documents, for blueprint/deployment review screens. */

export type DiffEntry = { path: string; kind: "added" | "removed" | "changed"; before?: unknown; after?: unknown };

export function jsonDiff(before: unknown, after: unknown, path = "", out: DiffEntry[] = []): DiffEntry[] {
  if (deepEqual(before, after)) return out;
  const isObj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);

  if (isObj(before) && isObj(after)) {
    const a = before as Record<string, unknown>, b = after as Record<string, unknown>;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in a)) out.push({ path: p, kind: "added", after: b[k] });
      else if (!(k in b)) out.push({ path: p, kind: "removed", before: a[k] });
      else jsonDiff(a[k], b[k], p, out);
    }
    return out;
  }

  // Arrays of keyed objects (workflows by key, nodes/presets by id) diff by key, others wholesale.
  if (Array.isArray(before) && Array.isArray(after)) {
    const key = arrayKey(before) ?? arrayKey(after);
    if (key) {
      const ma = new Map(before.map((x) => [String((x as Record<string, unknown>)[key]), x]));
      const mb = new Map(after.map((x) => [String((x as Record<string, unknown>)[key]), x]));
      for (const k of new Set([...ma.keys(), ...mb.keys()])) {
        const p = `${path}[${key}=${k}]`;
        if (!ma.has(k)) out.push({ path: p, kind: "added", after: mb.get(k) });
        else if (!mb.has(k)) out.push({ path: p, kind: "removed", before: ma.get(k) });
        else jsonDiff(ma.get(k), mb.get(k), p, out);
      }
      return out;
    }
  }

  out.push({ path: path || "(root)", kind: "changed", before, after });
  return out;
}

function arrayKey(arr: unknown[]): string | null {
  if (!arr.length || !arr.every((x) => x && typeof x === "object" && !Array.isArray(x))) return null;
  for (const k of ["id", "key", "ref", "name"]) {
    const vals = arr.map((x) => (x as Record<string, unknown>)[k]);
    if (vals.every((v) => typeof v === "string") && new Set(vals).size === vals.length) return k;
  }
  return null;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Deep merge: objects merge recursively, arrays and scalars from `over` replace `base`. */
export function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (base && over && typeof base === "object" && typeof over === "object" && !Array.isArray(base) && !Array.isArray(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = deepMerge((base as Record<string, unknown>)[k], v);
    }
    return out as T;
  }
  return over as T;
}

/** Stable JSON stringify (sorted keys) — used for content hashes. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
