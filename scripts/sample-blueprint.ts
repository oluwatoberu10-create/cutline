/** Regenerates docs/sample-blueprint.json from the starter configuration (placeholders only, no credentials). */
import { writeFileSync } from "node:fs";
import { defaultAgentConfig } from "../src/lib/blueprint/defaults";
import { buildBlueprint, validateBlueprintDocument } from "../src/lib/blueprint/package";

const bp = buildBlueprint({
  uid: "00000000-0000-4000-8000-000000000001", name: "Sample tutorial-channel agent",
  description: "Example blueprint: channel intelligence, review-first editing of raw footage and approval-based publishing. Placeholder settings only.",
  version: "1.0.0", changelog: "Sample", createdAt: new Date("2026-01-01T00:00:00Z"),
}, defaultAgentConfig());
const report = validateBlueprintDocument(JSON.parse(JSON.stringify(bp)));
if (!report.ok) { console.error(report.errors); process.exit(1); }
writeFileSync("docs/sample-blueprint.json", JSON.stringify(bp, null, 2) + "\n");
console.log("wrote docs/sample-blueprint.json (valid)");
