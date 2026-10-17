/** Validates a blueprint .json or .zip without a database: npm run blueprint:validate -- ./file.zip */
import { readFileSync } from "node:fs";
import { readPackage, validateBlueprintDocument } from "../src/lib/blueprint/package";

const file = process.argv[2];
if (!file) { console.error("usage: npm run blueprint:validate -- <file.json|file.zip>"); process.exit(1); }
const { raw, problems } = readPackage(new Uint8Array(readFileSync(file)), file);
for (const p of problems) console.log(`package: ${p}`);
if (raw === undefined) process.exit(1);
const r = validateBlueprintDocument(raw);
console.log(`compatible: ${r.compatibility.compatible}${r.compatibility.reason ? ` (${r.compatibility.reason})` : ""}`);
for (const e of r.errors) console.log(`error: ${e}`);
for (const w of r.warnings) console.log(`warning: ${w}`);
for (const s of r.secrets) console.log(`secret-like value at ${s.path}: ${s.rule}`);
if (r.ok) console.log(`OK: ${r.blueprint!.blueprint.name} v${r.blueprint!.blueprint.version}; requires ${r.requirements.integrations.map((i) => i.ref).join(", ")}`);
process.exit(r.ok ? 0 : 1);
