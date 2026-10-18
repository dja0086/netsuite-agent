#!/usr/bin/env -S npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { NsClient } from "@ns-agent/ns-client";
import { DenyAllApprovals } from "./policy/approval";
import { auditSinkFromEnv } from "./policy/audit";
import { redactFieldsFromEnv } from "./policy/redact";
import { createGateway } from "./server";
import { loadSkills, selectSkills } from "./skills";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillsDir = process.env.NS_AGENT_SKILLS_DIR ?? path.resolve(here, "../../../skills");

const skills = selectSkills(await loadSkills(skillsDir), process.env.NS_AGENT_SKILLS);
const { server, exposed } = createGateway({
  ns: NsClient.fromEnv(),
  skills,
  audit: auditSinkFromEnv(),
  approvals: new DenyAllApprovals(),
  redactFields: redactFieldsFromEnv(),
});

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol; diagnostics go to stderr only.
process.stderr.write(
  `[gateway] serving ${exposed.length} tools for skills: ${skills.map((s) => s.manifest.name).join(", ")}\n`,
);
