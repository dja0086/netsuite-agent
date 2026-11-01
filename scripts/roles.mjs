#!/usr/bin/env node
/**
 * node scripts/roles.mjs [--check]
 * Generates one SDF role per tier in roles/tiers.json into netsuite/src/Objects. With --check it changes nothing
 * and fails when a role file differs from what tiers.json says, or when a tier breaks the rules below (CI runs it).
 * Node built-ins only.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const { base, tiers } = JSON.parse(readFileSync(path.join(repoRoot, "roles", "tiers.json"), "utf8"));

const LEVELS = ["VIEW", "CREATE", "EDIT", "FULL"];
/** Above VIEW even in a tier with no write tools: login, connector access, workbooks (no View level), and the forced address list. */
const ALWAYS_ABOVE_VIEW = new Set(["ADMI_LOGIN_OAUTH2", "ADMI_MCP_SERVER", "ADMI_RESTWEBSERVICES", "REPO_ANALYTICS", "LIST_OTHER_ADDRESS"]);
const xmlText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Rule violations in tiers.json. */
function problems() {
  const out = [];
  const ids = new Set();
  const roles = new Set();
  for (const t of tiers) {
    if (!/^[a-z][a-z0-9_]*$/.test(t.id ?? "")) out.push(`tier id "${t.id}" must be lower-case letters, digits and _`);
    if (ids.has(t.id)) out.push(`tier id "${t.id}" is used twice`);
    ids.add(t.id);
    if (!/^customrole_(nsagent_[a-z0-9_]+|ns_agent)$/.test(t.role ?? "")) out.push(`tier "${t.id}": role "${t.role}" must start with customrole_nsagent_ (or the existing customrole_ns_agent)`);
    if (roles.has(t.role)) out.push(`tier "${t.id}": role "${t.role}" is used by two tiers`);
    roles.add(t.role);
    if (!Array.isArray(t.writeTools)) out.push(`tier "${t.id}": writeTools must be a list`);
    if (t.vault !== null && !/^vlt_[A-Za-z0-9]+$/.test(t.vault ?? "")) out.push(`tier "${t.id}": vault must be a vlt_ id or null`);
    for (const [key, level] of Object.entries({ ...base, ...t.permissions })) {
      if (!LEVELS.includes(level)) out.push(`tier "${t.id}": ${key} has unknown level ${level}`);
      if (t.writeTools?.length === 0 && LEVELS.indexOf(level) > 0 && !ALWAYS_ABOVE_VIEW.has(key))
        out.push(`tier "${t.id}" has no write tools, so ${key} must be VIEW, not ${level}`);
    }
  }
  return out;
}

/** The role XML for a tier, in the layout NetSuite exports (base permission order, tier levels applied in place). */
function roleXml(t) {
  const permissions = { ...base, ...t.permissions };
  const perms = Object.entries(permissions)
    .map(([key, level]) => `    <permission>\n      <permkey>${key}</permkey>\n      <permlevel>${level}</permlevel>\n    </permission>\n`)
    .join("");
  return `<role scriptid="${t.role}">
  <centertype>ACCOUNTCENTER</centertype>
  <coreadminpermission>F</coreadminpermission>
  <custrecord_dunning_role_flag></custrecord_dunning_role_flag>
  <custrecord_za_availableforzoneapprovals>F</custrecord_za_availableforzoneapprovals>
  <employeerestriction>NONE</employeerestriction>
  <employeeselectionunrestricted>F</employeeselectionunrestricted>
  <isinactive>F</isinactive>
  <ispartnerrole>F</ispartnerrole>
  <issalesrole>F</issalesrole>
  <issinglesignononly>F</issinglesignononly>
  <issuerole></issuerole>
  <issupportrole>F</issupportrole>
  <iswebserviceonlyrole>F</iswebserviceonlyrole>
  <name>${xmlText(t.roleName)}</name>
  <parentrolescriptid></parentrolescriptid>
  <restrictbydevice>F</restrictbydevice>
  <restricttimeandexpenses>F</restricttimeandexpenses>
  <subsidiaryoption>ALL</subsidiaryoption>
  <subsidiaryviewingallowed>F</subsidiaryviewingallowed>
  <tfaduration>0</tfaduration>
  <tfarequired>OFF</tfarequired>
  <permissions>
${perms}  </permissions>
</role>
`;
}

const errors = problems();
for (const t of errors.length ? [] : tiers) {
  const file = path.join(repoRoot, "netsuite", "src", "Objects", `${t.role}.xml`);
  const want = roleXml(t);
  const have = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (have === want) continue;
  if (check) errors.push(`${path.relative(repoRoot, file)} does not match roles/tiers.json; run \`node scripts/roles.mjs\``);
  else {
    writeFileSync(file, want);
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
}
if (errors.length) {
  console.error(errors.map((e) => `roles: ${e}`).join("\n"));
  process.exit(1);
}
console.log(`roles: ${tiers.length} tiers (${tiers.map((t) => t.id).join(", ")}), role files ${check ? "match" : "up to date"}`);
