#!/usr/bin/env node
/**
 * node scripts/sdf-check.mjs [projectDir]   (pnpm sdf:check)
 * Offline checks of the SuiteCloud project in netsuite/src. No account, no secrets.
 *
 * SuiteCloud CLI 4.x validates only on the server (`project:validate` ignores --server and needs an
 * auth ID), so pull requests get these structural checks instead; deploy-sdf.yml runs the server
 * validation in each stage before it deploys. Uses Node built-ins and `xmllint` (libxml2).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.argv[2] ?? path.join(repoRoot, "netsuite", "src"));
const objectsDir = path.join(src, "Objects");
const cabinetDir = path.join(src, "FileCabinet");
const errors = [];
const warnings = [];
const rel = (f) => path.relative(repoRoot, f);

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

if (spawnSync("xmllint", ["--version"]).error) {
  console.error("xmllint not found: install libxml2 (`sudo apt-get install -y libxml2-utils`; macOS ships it)");
  process.exit(2);
}

for (const f of ["manifest.xml", "deploy.xml"]) {
  if (!existsSync(path.join(src, f))) errors.push(`${rel(path.join(src, f))}: missing`);
}
const manifest = existsSync(path.join(src, "manifest.xml")) ? readFileSync(path.join(src, "manifest.xml"), "utf8") : "";
if (manifest && !/projecttype="ACCOUNTCUSTOMIZATION"/.test(manifest)) {
  errors.push("manifest.xml: projecttype must be ACCOUNTCUSTOMIZATION (a SuiteApp deploy deletes what it leaves out)");
}

// Well-formed XML. *.template.xml are BFO + FreeMarker sources, which are not XML until rendered.
const xmlFiles = walk(src).filter((f) => f.endsWith(".xml") && !f.endsWith(".template.xml"));
for (const f of xmlFiles) {
  const r = spawnSync("xmllint", ["--noout", "--nonet", f], { encoding: "utf8" });
  if (r.status !== 0) errors.push(`${rel(f)}: not well-formed XML\n    ${r.stderr.trim().split("\n")[0]}`);
}

// Objects: file name = scriptid, referenced files exist, PDF templates have their source.
const objectFiles = walk(objectsDir).filter((f) => f.endsWith(".xml") && !f.endsWith(".template.xml"));
const scriptIds = new Set();
const refs = [];
for (const f of objectFiles) {
  const xml = readFileSync(f, "utf8");
  const root = /<([a-z]+)\s[^>]*\bscriptid="([^"]+)"/.exec(xml);
  if (!root) {
    errors.push(`${rel(f)}: root element has no scriptid attribute`);
    continue;
  }
  const [, type, scriptId] = root;
  if (scriptIds.has(scriptId)) errors.push(`${rel(f)}: duplicate scriptid ${scriptId}`);
  scriptIds.add(scriptId);
  if (path.basename(f, ".xml") !== scriptId) errors.push(`${rel(f)}: file name must be ${scriptId}.xml`);
  if (type === "advancedpdftemplate" && !existsSync(path.join(path.dirname(f), `${scriptId}.template.xml`))) {
    errors.push(`${rel(f)}: missing ${scriptId}.template.xml next to it`);
  }
  for (const m of xml.matchAll(/\[(\/[^\]]+)\]/g)) {
    if (!existsSync(path.join(cabinetDir, m[1]))) errors.push(`${rel(f)}: references ${m[1]}, which is not in FileCabinet`);
  }
  for (const m of xml.matchAll(/\[scriptid=([a-z0-9_]+)(?:\.[a-z0-9_]+)*\]/g)) refs.push([f, m[1]]);
}
for (const [f, id] of refs) {
  if (!scriptIds.has(id)) warnings.push(`${rel(f)}: references ${id}, which is not in this project (it must already exist in the account)`);
}

// SuiteScript files parse.
for (const f of walk(cabinetDir).filter((f) => f.endsWith(".js"))) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) errors.push(`${rel(f)}: syntax error\n    ${r.stderr.trim().split("\n").slice(0, 4).join("\n    ")}`);
}

for (const w of warnings) console.log(`WARN ${w}`);
for (const e of errors) console.log(`FAIL ${e}`);
console.log(
  `sdf-check: ${xmlFiles.length} XML files, ${objectFiles.length} objects; ${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length ? 1 : 0);
