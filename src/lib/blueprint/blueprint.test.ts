import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { defaultAgentConfig } from "./defaults";
import { buildBlueprint, packageFiles, packageZip, readPackage, validateBlueprintDocument } from "./package";
import { scanForSecrets } from "./scan";
import { deepMerge, jsonDiff } from "./diff";

const meta = { uid: "6f1c2a3b-4d5e-4f60-8a1b-2c3d4e5f6a7b", name: "Test agent", description: "d", version: "1.0.0" };
const fresh = () => JSON.parse(JSON.stringify(buildBlueprint(meta, defaultAgentConfig())));

describe("blueprint format", () => {
  it("the default config builds a valid blueprint", () => {
    const report = validateBlueprintDocument(fresh());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.requirements.integrations.map((i) => i.ref)).toContain("youtube_connection");
  });

  it("round-trips through a ZIP package with verified checksums", () => {
    const bp = buildBlueprint(meta, defaultAgentConfig());
    const zip = packageZip(bp);
    const { raw, problems } = readPackage(zip, "x.zip");
    expect(problems).toEqual([]);
    const report = validateBlueprintDocument(raw);
    expect(report.ok).toBe(true);
    expect(report.blueprint).toEqual(bp);
    expect(Object.keys(unzipSync(zip))).toEqual(expect.arrayContaining([
      "manifest.json", "blueprint.json", "README.md", ".env.example", "schema/blueprint.schema.json", "workflows/footage_to_publish.json",
    ]));
  });

  it("export files contain no secret values", () => {
    const bp = buildBlueprint(meta, defaultAgentConfig());
    for (const f of packageFiles(bp)) expect(scanForSecrets(f.content), f.path).toEqual([]);
    const env = packageFiles(bp).find((f) => f.path === ".env.example")!.content;
    expect(env).toMatch(/^OPENAI_API_KEY=$/m);
  });

  it("detects a tampered ZIP", () => {
    const files = unzipSync(packageZip(buildBlueprint(meta, defaultAgentConfig())));
    const modified = JSON.parse(strFromU8(files["blueprint.json"]));
    modified.blueprint.name = "Tampered";
    files["blueprint.json"] = strToU8(JSON.stringify(modified));
    expect(readPackage(zipSync(files), "x.zip").problems.join(" ")).toMatch(/Checksum mismatch for blueprint.json/);
  });

  it("rejects path traversal inside a ZIP", () => {
    const zip = zipSync({ "../evil.json": strToU8("{}"), "blueprint.json": strToU8("{}") });
    expect(readPackage(zip, "x.zip").problems[0]).toMatch(/unsafe path/);
  });

  it("rejects secrets pasted into instructions without echoing them", () => {
    const bp = fresh();
    bp.config.instructions.system += " key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const report = validateBlueprintDocument(bp);
    expect(report.ok).toBe(false);
    expect(report.secrets[0].rule).toBe("Anthropic API key");
    expect(JSON.stringify(report.secrets)).not.toContain("abcdefghijklmnop");
  });

  it("rejects unknown keys such as smuggled account ids", () => {
    const bp = fresh();
    bp.config.integrations[0].accountId = "123";
    expect(validateBlueprintDocument(bp).ok).toBe(false);
  });

  it("reports unsupported workflow nodes and executes nothing", () => {
    const bp = fresh();
    bp.config.workflows[0].nodes.push({ id: "evil", type: "shell.exec", config: { cmd: "rm -rf /" }, dependsOn: [] });
    const report = validateBlueprintDocument(bp);
    expect(report.ok).toBe(false);
    expect(report.workflowIssues.some((i) => /Unsupported node type "shell.exec"/.test(i.message))).toBe(true);
  });

  it("refuses incompatible versions with a clear reason", () => {
    const bp = fresh();
    bp.schemaVersion = "2.0.0";
    const report = validateBlueprintDocument(bp);
    expect(report.compatibility.compatible).toBe(false);
    expect(report.errors[0]).toMatch(/different major version/);
    bp.schemaVersion = "1.0.0";
    bp.compatibility.minAppVersion = "9.0.0";
    expect(validateBlueprintDocument(bp).errors[0]).toMatch(/Requires application 9.0.0/);
  });

  it("detects workflow cycles", () => {
    const bp = fresh();
    bp.config.workflows[0].nodes[0].dependsOn = ["ideas"];
    expect(validateBlueprintDocument(bp).errors.join(" ")).toMatch(/cycle/);
  });

  it("diffs keyed arrays by key and merges overrides without prototype pollution", () => {
    const a = { presets: [{ id: "a", crf: 20 }, { id: "b", crf: 20 }] };
    const b = { presets: [{ id: "a", crf: 22 }, { id: "c", crf: 20 }] };
    expect(jsonDiff(a, b).map((x) => `${x.kind}:${x.path}`)).toEqual(["changed:presets[id=a].crf", "removed:presets[id=b]", "added:presets[id=c]"]);
    const merged = deepMerge({ x: { y: 1 } }, JSON.parse('{"__proto__":{"polluted":true},"x":{"z":2}}'));
    expect(merged).toEqual({ x: { y: 1, z: 2 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("secret scanner", () => {
  it.each([
    ["ya29.a0AfH6SMBxxxxxxxxxxxxxxxxxxxxxx", "Google OAuth access token"],
    ["1//0gLxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "Google OAuth refresh token"],
    ["AKIAIOSFODNN7EXAMPLE", "AWS access key id"],
    ["https://bucket.s3.amazonaws.com/x.mp4?X-Amz-Signature=abcdef0123456789", "Signed URL"],
    ["UCxxxxxxxxxxxxxxxxxxxxxx", "YouTube channel id"],
  ])("flags %s", (value, rule) => {
    expect(scanForSecrets({ note: value }).map((f) => f.rule)).toContain(rule);
  });

  it("allows placeholders in secret-named fields", () => {
    expect(scanForSecrets({ apiKey: "<your-key>" })).toEqual([]);
  });
});
