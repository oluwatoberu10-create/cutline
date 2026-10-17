import { describe, expect, it } from "vitest";
import { evaluate, readPath } from "./condition";
import { topoSort, validateWorkflow, workflowSchema } from "./definition";

describe("conditions", () => {
  const scope = { config: { modules: { editing: { mode: "automatic" } } }, input: { n: 3 }, steps: { a: { output: { ok: true } } } };

  it("evaluates comparisons and combinators", () => {
    expect(evaluate({ path: "config.modules.editing.mode", op: "eq", value: "automatic" }, scope)).toBe(true);
    expect(evaluate({ all: [{ path: "input.n", op: "gt", value: 2 }, { not: { path: "steps.a.output.ok", op: "eq", value: false } }] }, scope)).toBe(true);
    expect(evaluate({ any: [{ path: "input.missing", op: "exists" }] }, scope)).toBe(false);
  });

  it("never walks the prototype chain or leaves its scope", () => {
    expect(readPath(scope, "config.constructor")).toBeUndefined();
    expect(readPath(scope, "config.__proto__")).toBeUndefined();
    expect(readPath(scope, "process.env")).toBeUndefined();
  });
});

describe("workflow validation", () => {
  const wf = (nodes: unknown[]) => workflowSchema.parse({ key: "test_wf", name: "t", nodes });

  it("topologically sorts and detects cycles", () => {
    expect(topoSort([{ id: "b", dependsOn: ["a"] }, { id: "a", dependsOn: [] }])).toEqual(["a", "b"]);
    expect(topoSort([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }])).toBeNull();
  });

  it("rejects $from references to non-ancestors", () => {
    const issues = validateWorkflow(wf([
      { id: "a", type: "media.transcribe", config: { asset: { $from: "input.assetId" } } },
      { id: "b", type: "edit.propose", config: { asset: { $from: "steps.c.output.x" } }, dependsOn: ["a"] },
      { id: "c", type: "channel.sync", config: {} },
    ]));
    expect(issues.some((i) => /not an upstream dependency/.test(i.message))).toBe(true);
  });

  it("validates node config against the registry", () => {
    const issues = validateWorkflow(wf([{ id: "a", type: "channel.sync", config: { maxVideos: 99999 } }]));
    expect(issues[0].message).toMatch(/Invalid config/);
  });
});
