> **Snapshot, not the source of truth.** Exported 2026-10-22 (doc rev 29) from the "Architecture & design" tab of the "NetSuite Agent Monorepo" doc (https://claude.ai/artifact/QXJx7u8nAr7L5iAe1DD3jq). The online doc wins if they differ; re-export after design changes. Delivery tasks and exit gates live in CLAUDE.md. Later decisions in docs/adr/ (0004-0006) and CLAUDE.md supersede this design where they conflict (for example, imports use the REST Record API per ADR 0005, not a CSV import RESTlet).

# NetSuite Agent Monorepo — Architecture & Implementation Design

Oct 18, 2026 · @dom

## Summary

Build one TypeScript monorepo holding three things: an MCP gateway the agent calls, a SuiteCloud (SDF) project deployed into NetSuite, and one skill per capability. Reads go live through SuiteQL and the REST Record API. Schema changes (custom fields, PDF templates) are generated as SDF objects and shipped through CI with human approval; the agent never edits account configuration live.

Key decisions:

- **Auth: OAuth 2.0 client credentials only.** Starting with NetSuite 2027.1, no new integration can use token-based authentication (TBA) for SOAP, REST or RESTlets ([RSM](https://technologyblog.rsmus.com/technologies/netsuite/netsuite-2026-1-critical-changes-clients-must-address-now/)), so this design does not touch TBA.
- **Reads: SuiteQL first.** One SuiteQL call returns joined rows; the REST Record API is kept for single-record reads and metadata.
- **Limits: one governance limiter.** Every outbound call passes a concurrency cap sized to the integration's allocated limit, with backoff on throttling errors.
- **Interop: complement Oracle's MCP stack.** Oracle's MCP Standard Tools SuiteApp already covers record CRUD, saved searches, reports and SuiteQL ([anchorgroup](https://www.anchorgroup.tech/blog/netsuite-mcp-connector)). This repo adds what it lacks (search authoring, SDF-backed fields and templates, report definitions) and can also publish those as AI Connector custom tools.
- **Licensing: no paid third-party services.** Tooling is Oracle's SuiteCloud CLI plus permissively licensed open source (MCP SDK, zod, jose, ExcelJS, pnpm, Turborepo). No iPaaS or commercial connector.

Inputs still open are marked **\[FILL\]** and collected in the last section.

Phases, checkpoints and the build checklist are in Delivery plan.

## High-level architecture

*(Architecture diagram: agent side, gateway, NetSuite account. It does not export; see the online doc.)*

The agent never talks to NetSuite directly. The gateway is an MCP server that validates tool inputs, applies policy and approvals, and sends every request through one limiter using OAuth 2.0 tokens. NetSuite is reached four ways: SuiteQL for reads, the REST Record API for single records and metadata, RESTlets for saved searches and PDF rendering, and SDF deployments for schema changes.

A second path runs beside it: MCP clients can connect straight to the account's AI Connector Service, which serves Oracle's Standard Tools plus the custom tools this repo deploys. Use that path for simple reads; use the gateway whenever you need the limiter, approvals, file exports or SDF changes.

Three request flows cover the read, search and schema capabilities; data import, the fourth, is described under the sample code:

1. **Read** (data explorer, reports): skill picks a tool, gateway checks policy, limiter sends SuiteQL, rows come back capped at 200 with the rest exported to a file.
2. **Saved search**: preview runs in the RESTlet, a human approves, the same RESTlet saves it under the `customsearch_nsagent_` prefix.
3. **Field or template**: SDF XML is generated, a PR opens, CI validates against the sandbox, a reviewer approves, CI deploys to sandbox then production.

## Required skills and responsibilities

Six user-facing skills map one-to-one to the requested capabilities (data import added); two platform skills hold the rules every other skill follows. Each skill is a `SKILL.md` folder: when to use it, the tools it may call, worked examples, and what needs approval.

| Skill | Responsibility | Gateway tools | NetSuite surface | Writes to NetSuite |
| --- | --- | --- | --- | --- |
| search-builder | Turn a question into a saved search spec, preview the first page, save it on approval | `ns_search_preview`, `ns_search_save` | RESTlet using `N/search` | Saved search, after approval |
| custom-fields | Design a field spec, generate SDF XML, open a pull request | `ns_field_plan`, `ns_field_generate` | SDF objects (`transactionbodycustomfield`, `entitycustomfield`, `itemcustomfield`, and others) | Only through CI deploy |
| pdf-templates | Draft or edit Advanced PDF/HTML (FreeMarker) templates, render a preview against a real record | `ns_pdf_preview`, `ns_pdf_template_generate` | RESTlet using `N/render`; SDF `advancedpdftemplate` | Only through CI deploy |
| reports | Define reports as SuiteQL plus aggregation, run them, export CSV, XLSX or PDF; route standard reports to Oracle's report tool | `ns_report_run`, `ns_report_export` | SuiteQL; MCP Standard Tools report tool | None |
| data-explorer | List record types, describe fields, query any record, run global search | `ns_catalog_list`, `ns_record_describe`, `ns_suiteql`, `ns_record_get`, `ns_global_search` | REST metadata catalog, SuiteQL, REST Record API, RESTlet `search.global` | None |
| data-importer | Parse CSV or XLSX, map columns to fields, validate, dry-run, then upsert by external ID after approval; hand large files to NetSuite's CSV import queue | ns\_import\_plan, ns\_import\_dry\_run, ns\_import\_run, ns\_import\_status | REST Record API (upsert by external ID); RESTlet using N/task CSV import; SDF savedcsvimport | Records, after approval of a dry-run |
| ns-conventions (platform) | Script ID prefixes, naming, SuiteQL idioms, governance budgets per tool | None | None | None |
| change-control (platform) | How a change becomes a PR, gets approved, deploys to sandbox then production, and rolls back | `ns_change_open_pr` | SuiteCloud CLI in CI | Via CI only |

The agent host decides which skill applies from the `SKILL.md` description; the gateway enforces what each tool may do, so a misrouted skill still cannot write.

## Skill lifecycle: accepting, improving and adding skills

A skill ships only when its evals pass in CI and its owners approve. Every later change, whether an improvement or a net-new skill, goes through the same gate with evidence; nobody edits a skill directly on main.

### Anatomy of a skill

```
skills/data-importer/
├── SKILL.md            # frontmatter + instructions the agent reads
├── evals/
│   ├── triggers.yaml   # prompts that SHOULD and SHOULD NOT route here
│   └── tasks.yaml      # end-to-end cases run on the sandbox, with expected outcomes
├── examples/           # worked conversations, synthetic data only
├── CHANGELOG.md
└── OWNERS              # skill owner + backup reviewer
```

```yaml
---
name: data-importer
description: Import CSV or XLSX files into NetSuite records. Use when the user wants to load, bulk-create or bulk-update records from a file. Not for editing a single record.
version: 1.0.0
owner: "[FILL: team handle]"
tools: [ns_import_plan, ns_import_dry_run, ns_import_run, ns_import_status, ns_record_describe]
writes: true
governance_budget: { max_calls_per_invocation: 2000, max_concurrency: 2 }
---
```

The agent host reads `name` and `description` to choose the skill; the gateway and CI read `version`, `tools`, `writes` and `governance_budget` to enforce it.

> **Callout: the gateway enforces the manifest.** A skill that lists a tool missing from the gateway registry fails CI. At runtime, a call to a tool the active skill did not declare is refused and logged.

### Acceptance criteria

A skill, new or changed, is accepted when every row passes. Thresholds are starting points to agree with the team: **\[FILL: agreed thresholds\]**.

| Criterion | Pass threshold | Checked by |
| --- | --- | --- |
| Trigger precision | ≥ 95% of its should-route prompts route to it; ≤ 3% of other skills' prompts do | `skills-eval.yml`, trigger evals across all skills |
| Task success | ≥ 90% of task cases pass on the sandbox | `skills-eval.yml`, task evals |
| Write safety | 100% of cases prove each write tool blocks without approval | Contract test per write tool |
| Tool scope | Every eval transcript calls only declared tools | Gateway audit log from the eval run |
| Governance | Eval runs stay inside the declared budget with zero unhandled throttle errors | Limiter metrics from the eval run |
| Data hygiene | No secrets, account IDs or real customer data in the skill folder | Secret scan + reviewer |
| Documentation | Owner set, CHANGELOG entry, at least 3 examples | CODEOWNERS review |

Required approvers: the skill owner always; the NetSuite admin when `writes: true` or the change adds a RESTlet or SDF object; security when the change exposes new record types or PII fields.

> **Callout: SKILL.md wording is code.** Changing a sentence changes routing and behavior, so prose-only edits run the same evals as code changes.

### Improving an existing skill

Improvement signals come from the audit log (misroutes, refused tool calls, failed calls), rejected approvals, user feedback, and NetSuite release changes.

1. **Reproduce first.** Add the failing prompt or case to `evals/`; it must fail on main before any fix is written.
2. **Change the skill.** Edit `SKILL.md`, examples or the tool, never the eval to make it pass.
3. **Classify the bump.**
   1. Patch: wording or examples, no behavior change.
   2. Minor: new tool, new supported record type, new eval cases.
   3. Major: changes triggers, removes a capability, or changes what gets written to NetSuite.
4. **Attach evidence.** The PR shows before and after scores for this skill, plus trigger scores for every other skill.
5. **Merge by class.** Patch: owner. Minor: owner + one reviewer. Major: owner + NetSuite admin + a sandbox canary of **\[FILL: days\]**.

> **Callout: no-regression rule.** A PR that lowers any other skill's trigger precision or task success by more than 2 points is blocked, even if its own skill improves.

### Adding a net-new skill

1. **Proposal issue** from the template: problem, users, at least 10 example prompts, tools needed, NetSuite surface, whether it writes, governance estimate, data exposure.
2. **Overlap check.** Run the proposal's prompts through the current trigger evals. If an existing skill already wins most of them, extend that skill through the improvement path instead.
3. **Scaffold.** `pnpm new:skill <name>` copies `skills/_template`, creates `apps/mcp-gateway/src/tools/<name>.ts` with stubs, and adds a CODEOWNERS line.
4. **Evals before instructions.** Write `triggers.yaml` and `tasks.yaml`, then `SKILL.md`.
5. **Build tools.** NetSuite-side code is a new RESTlet or custom tool under `netsuite/`, deployed through SDF like everything else.
6. **Ship disabled.** The skill is registered with `enabled: false` in gateway config and turned on for a pilot group on the sandbox.
7. **Accept.** Meets the acceptance table, approvals collected, released as 1.0.0.
8. **Promote.** Production rollout through change-control, same as an SDF change.

> **Callout: write tools start behind dry-run.** The first release of any write-capable skill exposes only its plan and dry-run tools. The write tool is enabled in a follow-up release after a sandbox run reconciles cleanly.

### Retiring a skill

Set `deprecated: true` and name the replacement in the description. The gateway logs remaining calls for one release; the folder is removed after **\[FILL: days\]** with zero calls.

## Repository layout

A pnpm + Turborepo workspace with four top-level areas: `apps/` (things that run), `packages/` (shared libraries), `netsuite/` (the SDF project that deploys into the account) and `skills/` (agent instructions). Existing repo layout: **\[FILL: current repo layout\]**; if one exists, `netsuite/` and `skills/` can be dropped in alongside it.

```
netsuite-agent/
├── package.json                 # workspace root, turbo scripts
├── pnpm-workspace.yaml
├── turbo.json
├── scripts/new-skill.ts           # pnpm new:skill <name> scaffolder
├── .env.example                 # variable NAMES only, never values
├── .github/CODEOWNERS            # owners per skill, NetSuite admin, security
├── .github/workflows/
│   ├── ci.yml                   # lint, typecheck, tests, secret scan, sdf validate
│   ├── skills-eval.yml          # trigger + task evals on any skills/ change
│   └── deploy-sdf.yml           # approval-gated suitecloud project:deploy
├── apps/
│   ├── mcp-gateway/             # MCP server exposing ns_* tools
│   │   └── src/
│   │       ├── server.ts
│   │       ├── tools/           # search.ts fields.ts pdf.ts reports.ts data.ts import.ts
│   │       └── policy/          # approval.ts audit.ts redact.ts
│   └── cli/                     # local runner: call tools, open PDF previews
├── packages/
│   ├── ns-client/               # the only code that talks to NetSuite
│   │   └── src/
│   │       ├── auth/oauth2-m2m.ts
│   │       ├── governance/limiter.ts
│   │       ├── rest/record.ts
│   │       ├── rest/suiteql.ts
│   │       └── restlet.ts
│   ├── suiteql/                 # keyset pager, catalog cache, query guards
│   ├── sdf-gen/                 # typed specs -> SDF XML (fields, templates)
│   ├── import-engine/           # parse, map, validate, dry-run, upsert
│   ├── report-engine/           # report definitions, aggregation, exports
│   ├── schemas/                 # zod schemas shared by tools and RESTlets
│   └── config/                  # tsconfig, eslint, prettier presets
├── netsuite/                    # SuiteCloud project (ACP or SuiteApp)
│   ├── suitecloud.config.js
│   └── src/
│       ├── manifest.xml
│       ├── deploy.xml
│       ├── FileCabinet/SuiteScripts/ns_agent/
│       │   ├── restlets/search_rl.js
│       │   ├── restlets/pdf_rl.js
│       │   ├── restlets/import_rl.js      # large files via N/task CSV import
│       │   ├── tools/agent_tools.js           # AI Connector custom tool script
│       │   ├── tools/agent_tools.schema.json
│       │   └── lib/governance.js
│       └── Objects/
│           ├── customscript_ns_agent_search_rl.xml
│           ├── customscript_ns_agent_pdf_rl.xml
│           ├── customrole_ns_agent.xml       # least-privilege integration role
│           ├── <custom tool object>.xml      # [FILL: tool object per SDF reference]
│           ├── fields/                       # generated custom fields, via PR
│           ├── templates/                    # generated PDF templates, via PR
│           └── imports/                      # saved CSV import maps, via PR
├── skills/
│   ├── search-builder/SKILL.md
│   ├── custom-fields/SKILL.md
│   ├── pdf-templates/SKILL.md
│   ├── reports/SKILL.md
│   ├── data-explorer/SKILL.md
│   ├── data-importer/SKILL.md
│   ├── ns-conventions/SKILL.md
│   ├── change-control/SKILL.md
│   └── _template/                # scaffold: SKILL.md, evals/, CHANGELOG.md, OWNERS
├── docs/
│   ├── adr/                     # auth, limits, SDF-only schema changes
│   └── netsuite-api/            # [FILL: NetSuite API documentation]
└── tests/
    ├── contract/                # recorded sandbox responses
    └── e2e/                     # sandbox only, never production
```

Key files:

- `packages/ns-client` is the single choke point: auth, limiter, retries and paging live here, so no tool can bypass governance.
- `apps/mcp-gateway/src/policy/approval.ts` blocks any tool marked `writes: true` until a human confirms.
- `netsuite/src/Objects/customrole_ns_agent.xml` defines the integration role in code, so permissions are reviewed like any other change.
- `.env.example` documents `NS_ACCOUNT_ID`, `NS_CLIENT_ID`, `NS_CERT_ID`, `NS_MAX_CONCURRENCY` and `SECRETS_BACKEND`; the private key is never a variable in the repo.

## Sample code for each capability

Every capability rides on the same two shared pieces (auth and the limiter), shown first. Snippets are trimmed for reading; validate field names against your account's SDF and SuiteScript references before use.

### Shared: OAuth 2.0 machine-to-machine token

`packages/ns-client/src/auth/oauth2-m2m.ts` signs a short-lived JWT with a certificate key pulled from the secrets backend at runtime.

```ts
import { SignJWT, importPKCS8 } from "jose";
import { secrets } from "./secrets"; // vault adapter: [FILL: secrets backend]

const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env ${k}`);
  return v;
};

let cached: { token: string; expiresAt: number } | undefined;

export async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;

  const host = env("NS_ACCOUNT_ID").toLowerCase().replace("_", "-");
  const tokenUrl = `https://${host}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
  const key = await importPKCS8(await secrets.get("netsuite/m2m-private-key"), "PS256");
  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({ scope: ["rest_webservices", "restlets"] })
    .setProtectedHeader({ alg: "PS256", typ: "JWT", kid: env("NS_CERT_ID") })
    .setIssuer(env("NS_CLIENT_ID"))
    .setAudience(tokenUrl)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status}`); // never log the body
  const { access_token, expires_in } = await res.json();
  cached = { token: access_token, expiresAt: Date.now() + expires_in * 1000 };
  return access_token;
}
```

### Shared: governance limiter

`packages/ns-client/src/governance/limiter.ts` caps in-flight requests and retries only throttling errors.

```ts
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isThrottle = (e: any) =>
  e?.status === 429 || /SSS_REQUEST_LIMIT_EXCEEDED|CONCURRENCY_LIMIT_EXCEEDED/.test(e?.body ?? "");

export class GovernanceLimiter {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly max = Number(process.env.NS_MAX_CONCURRENCY ?? 2)) {}

  async run<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (e) {
          if (!isThrottle(e) || i === attempts - 1) throw e;
          await sleep(Math.min(30_000, 500 * 2 ** i) * (0.5 + Math.random())); // backoff + jitter
        }
      }
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
```

### 1. Building searches

Oracle documents that AI Connector custom tool scripts cannot load `N/search`, `N/http` or `N/https` ([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/T_article_1185045525_1.html)), so saved-search authoring lives in a RESTlet. `netsuite/src/FileCabinet/SuiteScripts/ns_agent/restlets/search_rl.js`:

```js
/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/runtime', 'N/error'], (search, runtime, error) => {
  const ALLOWED = new Set(['customer', 'vendor', 'item', 'transaction', 'salesorder', 'invoice']); // [FILL]

  const build = (spec) => {
    if (!ALLOWED.has(spec.type)) {
      throw error.create({ name: 'NS_AGENT_TYPE_NOT_ALLOWED', message: spec.type });
    }
    if (spec.scriptId && !/^customsearch_nsagent_/.test(spec.scriptId)) {
      throw error.create({ name: 'NS_AGENT_BAD_SCRIPT_ID', message: spec.scriptId });
    }
    return search.create({
      type: spec.type,
      title: spec.title,
      id: spec.scriptId,
      filters: spec.filters,      // e.g. [['mainline','is','T'],'AND',['trandate','within','thismonth']]
      columns: spec.columns.map((c) => search.createColumn(c)),
    });
  };

  const post = (spec) => {
    const s = build(spec);
    if (spec.mode === 'save') return { id: s.save() }; // gateway only sends this after approval

    const paged = s.runPaged({ pageSize: Math.min(spec.pageSize || 50, 1000) });
    const rows = paged.count === 0 ? [] : paged.fetch({ index: 0 }).data.map((r) =>
      Object.fromEntries(s.columns.map((c) => [c.label || c.name, r.getText(c) || r.getValue(c)])));
    return { total: paged.count, rows, remainingUsage: runtime.getCurrentScript().getRemainingUsage() };
  };

  return { post };
});
```

Gateway side, `apps/mcp-gateway/src/tools/search.ts`:

```ts
import { z } from "zod";
import { SearchSpec } from "@ns-agent/schemas";

export function registerSearchTools(server, ns, approvals) {
  server.registerTool(
    "ns_search_preview",
    { description: "Preview the first page of a NetSuite saved search spec. Read-only.", inputSchema: SearchSpec.shape },
    async (spec) => json(await ns.restlet("customscript_ns_agent_search_rl", { ...spec, mode: "preview" })),
  );

  server.registerTool(
    "ns_search_save",
    { description: "Save a previewed search to NetSuite. Requires human approval.", inputSchema: SearchSpec.shape },
    async (spec) => {
      await approvals.require({ action: "save_search", summary: spec.title, payload: spec });
      return json(await ns.restlet("customscript_ns_agent_search_rl", { ...spec, mode: "save" }));
    },
  );
}

const json = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
```

### 2. Creating custom fields

Fields are generated as SDF XML and merged by pull request. `packages/sdf-gen/src/body-field.ts`:

```ts
import { z } from "zod";

export const BodyField = z.object({
  scriptId: z.string().regex(/^custbody_nsagent_[a-z0-9_]{1,20}$/),
  label: z.string().min(1).max(200),
  type: z.enum(["CHECKBOX", "CURRENCY", "DATE", "FREEFORMTEXT", "INTEGER", "SELECT", "TEXTAREA"]),
  appliesTo: z.array(z.enum(["SALE", "PURCHASE", "JOURNAL"])).min(1),
  help: z.string().default(""),
  selectRecordType: z.string().optional(), // required when type is SELECT
});

const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
const flag = (b: boolean) => (b ? "T" : "F");

export function bodyFieldXml(input: z.input<typeof BodyField>): string {
  const f = BodyField.parse(input);
  return `<transactionbodycustomfield scriptid="${f.scriptId}">
  <label>${esc(f.label)}</label>
  <fieldtype>${f.type}</fieldtype>
  <storevalue>T</storevalue>
  <bodysale>${flag(f.appliesTo.includes("SALE"))}</bodysale>
  <bodypurchase>${flag(f.appliesTo.includes("PURCHASE"))}</bodypurchase>
  <bodyjournal>${flag(f.appliesTo.includes("JOURNAL"))}</bodyjournal>
  <help>${esc(f.help)}</help>${f.selectRecordType ? `
  <selectrecordtype>${esc(f.selectRecordType)}</selectrecordtype>` : ""}
</transactionbodycustomfield>\n`;
}
```

The `ns_field_generate` tool writes the file to `netsuite/src/Objects/fields/`, and CI runs:

```bash
suitecloud project:validate --server   # against the sandbox
suitecloud project:deploy               # only after the approval step in deploy-sdf.yml
```

### 3. Customizing PDFs

The preview RESTlet renders a draft template against a real record without saving anything. `restlets/pdf_rl.js`:

```js
/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/render', 'N/record'], (render, record) => {
  const post = ({ recordType, recordId, templateXml }) => {
    const renderer = render.create();
    renderer.templateContent = templateXml; // draft from the agent; preview only
    renderer.addRecord({ templateName: 'record', record: record.load({ type: recordType, id: recordId }) });
    const pdf = renderer.renderAsPdf();
    return { fileName: `${recordType}_${recordId}.pdf`, base64: pdf.getContents() };
  };
  return { post };
});
```

A template the agent drafts (BFO + FreeMarker):

```xml
<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<pdf>
  <head><style>th { background-color: #eeeeee; }</style></head>
  <body size="Letter">
    <h1>${record.tranid}</h1>
    <p>${record.entity} · ${record.trandate}</p>
    <table width="100%">
      <thead><tr><th>Item</th><th align="right">Amount</th></tr></thead>
      <#list record.item as line>
        <tr><td>${line.item}</td><td align="right">${line.amount}</td></tr>
      </#list>
    </table>
  </body>
</pdf>
```

Once approved, `ns_pdf_template_generate` writes it as an `advancedpdftemplate` object under `Objects/templates/`, and it deploys through the same CI path as fields.

### 4. Generating reports

Reports are versioned definitions in `packages/report-engine/src/reports/`:

```ts
import type { ReportDef } from "../types";

export const openArByAge: ReportDef = {
  id: "open_ar_by_age",
  title: "Open AR by customer and age bucket",
  sql: `
    SELECT BUILTIN.DF(t.entity) AS customer,
           SUM(CASE WHEN t.duedate >= TRUNC(SYSDATE) THEN t.foreignamountunpaid ELSE 0 END) AS not_due,
           SUM(CASE WHEN TRUNC(SYSDATE) - t.duedate BETWEEN 1 AND 30 THEN t.foreignamountunpaid ELSE 0 END) AS d1_30,
           SUM(CASE WHEN TRUNC(SYSDATE) - t.duedate BETWEEN 31 AND 60 THEN t.foreignamountunpaid ELSE 0 END) AS d31_60,
           SUM(CASE WHEN TRUNC(SYSDATE) - t.duedate > 60 THEN t.foreignamountunpaid ELSE 0 END) AS d60_plus
    FROM transaction t
    WHERE t.type = 'CustInvc' AND t.foreignamountunpaid > 0
    GROUP BY BUILTIN.DF(t.entity)`,
  exports: ["csv", "xlsx", "pdf"],
};
```

```ts
// apps/mcp-gateway/src/tools/reports.ts
server.registerTool(
  "ns_report_run",
  { description: "Run a named report definition and return rows. Read-only.", inputSchema: { id: z.string() } },
  async ({ id }) => {
    const def = reports.get(id);
    const rows = await collect(suiteqlOffset(ns, def.sql)); // offset paging: grouped results stay far below the row cap
    return json({ title: def.title, rowCount: rows.length, rows: rows.slice(0, 200) });
  },
);
```

Aggregate reports already exist as NetSuite standard reports; for those, the reports skill routes to the report tool in Oracle's MCP Standard Tools SuiteApp instead of rebuilding them.

### 5. Viewing and searching all data

SuiteQL runs as a POST to the `suiteql` resource with the query in the `q` body parameter ([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html)). `packages/ns-client/src/rest/suiteql.ts`:

```ts
export async function suiteql(ns: NsClient, q: string, limit = 1000, offset = 0) {
  return ns.limiter.run(() =>
    ns.fetch(`/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`, {
      method: "POST",
      headers: { Prefer: "transient", "Content-Type": "application/json" },
      body: JSON.stringify({ q }),
    }),
  );
}

// Keyset paging: each call is small, so the per-query result cap never applies.
export async function* suiteqlAll(ns: NsClient, sql: string, key = "id") {
  let last = 0;
  for (;;) {
    const page = await suiteql(ns, `SELECT * FROM (${sql}) q WHERE q.${key} > ${last} ORDER BY q.${key}`);
    if (page.items.length === 0) return;
    yield* page.items;
    last = Number(page.items.at(-1)[key]);
  }
}
```

The data-explorer tools wrap these plus the metadata catalog:

```ts
server.registerTool("ns_record_describe",
  { description: "Describe fields of a record type.", inputSchema: { type: z.string() } },
  async ({ type }) => json(await ns.get(`/services/rest/record/v1/metadata-catalog/${type}`,
    { headers: { Accept: "application/schema+json" } })));

server.registerTool("ns_suiteql",
  { description: "Run a read-only SuiteQL SELECT. Returns up to 1,000 rows.", inputSchema: { q: z.string() } },
  async ({ q }) => json(await suiteql(ns, assertSelectOnly(q))));
```

SuiteQL cannot modify data, and the integration role limits which tables it can read, so "all data" means all data that role is permitted to see.

### 6. Importing data

Imports run as a staged pipeline (parse, map, validate, dry-run, approve, write, reconcile), so nothing reaches NetSuite until a human has seen the dry-run. Two write paths share the same plan:

| Path | Use when | Mechanism |
| --- | --- | --- |
| REST upsert | Up to **\[FILL: row threshold\]** rows | `PUT /services/rest/record/v1/{type}/eid:{externalId}` through the limiter; reruns are idempotent |
| CSV import task | Larger files | RESTlet submits an `N/task` CSV import using a saved import map; status is polled |

Plan and dry-run, `packages/import-engine/src/pipeline.ts`:

```ts
import { z } from "zod";

export const ImportPlan = z.object({
  recordType: z.string(),                       // allow-listed, e.g. "customer"
  externalIdColumn: z.string(),                 // drives idempotent upsert
  mapping: z.record(z.string(), z.string()),    // file column -> NetSuite field id
  mode: z.enum(["rest_upsert", "csv_task"]),
});

export async function dryRun(ns: NsClient, plan: z.infer<typeof ImportPlan>, rows: Row[]) {
  const schema = await ns.describe(plan.recordType); // metadata catalog, cached
  const errors: RowError[] = [];

  const payloads = rows.map((row, i) => {
    const body: Record<string, unknown> = {};
    for (const [col, field] of Object.entries(plan.mapping)) {
      const def = schema.properties[field];
      if (!def) { errors.push({ row: i + 2, col, error: `Unknown field ${field}` }); continue; }
      const v = coerce(row[col], def); // dates, numbers, booleans, list/record references
      if (v.error) errors.push({ row: i + 2, col, error: v.error });
      else body[field] = v.value;
    }
    return { externalId: String(row[plan.externalIdColumn]), body };
  });

  const existing = await existingExternalIds(ns, plan.recordType, payloads.map((p) => p.externalId)); // SuiteQL, batched
  return {
    creates: payloads.filter((p) => !existing.has(p.externalId)).length,
    updates: payloads.filter((p) => existing.has(p.externalId)).length,
    errors,
    sample: payloads.slice(0, 5),
    planHash: hash({ plan, payloads }), // approval binds to exactly this payload set
  };
}

export async function runRestUpsert(ns: NsClient, plan, payloads, approvedHash: string) {
  if (hash({ plan, payloads }) !== approvedHash) throw new Error("Payload changed since approval");
  const results = await Promise.allSettled(
    payloads.map((p) =>
      ns.limiter.run(() =>
        ns.put(`/services/rest/record/v1/${plan.recordType}/eid:${encodeURIComponent(p.externalId)}`, p.body),
      ),
    ),
  );
  return reconcile(payloads, results); // per-row status + an error CSV the user can fix and re-run
}
```

Large-file path, `netsuite/src/FileCabinet/SuiteScripts/ns_agent/restlets/import_rl.js`:

```js
/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 */
define(['N/task', 'N/error'], (task, error) => {
  const post = ({ mappingScriptId, csv, name }) => {
    if (!/^custimport_nsagent_/.test(mappingScriptId)) {
      throw error.create({ name: 'NS_AGENT_MAPPING_NOT_ALLOWED', message: mappingScriptId });
    }
    const t = task.create({ taskType: task.TaskType.CSV_IMPORT, mappingId: mappingScriptId, importFile: csv, name });
    return { taskId: t.submit() };
  };
  const get = ({ taskId }) => ({ status: task.checkStatus({ taskId }).status });
  return { post, get };
});
```

> **Callout: import guardrails.** Only allow-listed record types; approval is bound to the dry-run's `planHash`, so any change to the file or mapping needs a new approval; transactions with posting impact (invoices, journals) also need a finance approver (**\[FILL: approver group\]**); every run writes a reconciliation file listing each row's outcome.

## NetSuite API limits and governance strategy

NetSuite governs mainly by concurrency, not requests per minute, so the design caps in-flight calls rather than pacing them. All limits below are enforced in `packages/ns-client` or in the RESTlets, never left to the agent.

| Limit | Value | How this design handles it |
| --- | --- | --- |
| Account concurrency | Shared by SOAP, REST and RESTlet requests ([Jitterbit](https://docs.jitterbit.com/integration-studio/design/connectors/netsuite/netsuite-troubleshooting/concurrency-governance/)); base 5 (Standard), 15 (Premium), 20 (Enterprise/Ultimate), plus 10 per SuiteCloud Plus license ([SKU.io summary of Oracle docs](https://www.sku.io/netsuite-api-vs-sku-io/)) | Allocate a dedicated integration limit under Setup > Integration > Integration Management > Integration Governance; set `NS_MAX_CONCURRENCY` at or below it so other integrations keep their share. Default 2. |
| Throttle response | RESTlets return HTTP 400 with `SSS_REQUEST_LIMIT_EXCEEDED` ([Jitterbit](https://docs.jitterbit.com/integration-studio/design/connectors/netsuite/netsuite-troubleshooting/concurrency-governance/)); REST web services return 429 | Limiter retries only these, up to 5 times, exponential backoff with jitter, capped at 30 s. |
| SuiteQL result size | Paged queries cap at 1,000 rows per page and 1,000 pages; 100,000 results total unless SuiteAnalytics Connect is enabled ([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157960491275.html)) | Keyset paging on `id` for full scans; offset paging only for grouped results. Agent-facing tools return at most 200 rows and export the rest to a file. |
| RESTlet script budget | 5,000 usage units per RESTlet execution ([Oracle blog](https://blogs.oracle.com/developers/augment-netsuite-rest-functionality-with-restlet)) | Search preview fetches one page; RESTlets check `getRemainingUsage()` and stop early. Bulk work moves to a Map/Reduce script. |
| Custom tool modules | AI Connector custom tool scripts cannot use `N/search`, `N/http` or `N/https` ([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/T_article_1185045525_1.html)) | Custom tools use `N/query`; saved-search authoring stays in the RESTlet. |
| Record writes | The REST Record API writes one record per request, against the same account concurrency limit | The importer upserts through the limiter below the row threshold; above it, it submits a CSV import task that runs in NetSuite's own queue instead of holding concurrency slots. |

Observability: every call logs tool name, endpoint, latency, retry count and remaining usage to the audit log. Rejections also show in NetSuite under Setup > Integration > Web Services Usage Log, which is the first place to look when the rejected-request ratio rises.

## Security and credentials

No credential, key or account-specific secret is ever committed; the repo holds only variable names and identifiers that are useless without the private key.

- **Auth flow.** OAuth 2.0 client credentials with a certificate-signed JWT for server-to-server calls. If a user-facing flow is added later, new authorization-code integrations must use PKCE ([RSM](https://technologyblog.rsmus.com/technologies/netsuite/netsuite-2026-1-critical-changes-clients-must-address-now/)).
- **Secrets.** The private key lives in a secrets manager (**\[FILL: secrets backend\]**) and is read at runtime by `secrets.get()`. CI deploys use a separate certificate stored as a protected CI secret. A secret scanner runs on every push and blocks the merge on a hit.
- **Integration role.** A dedicated, web-services-only role defined in `customrole_ns_agent.xml`, with read permissions per record type and no setup permissions. The AI Connector Service refuses Administrator-level roles by design ([Numeric](https://www.numeric.io/blog/netsuite-mcp)), which matches this least-privilege stance.
- **Write control.** Tools are tagged read or write. Write tools (save search, open field or template PR) call `approvals.require()` and wait for a named human. Schema changes reach production only through the approval-gated deploy workflow.
- **Sandbox first.** Every change validates and deploys to a sandbox account before production; end-to-end tests never target production.
- **Data exposure.** Tool outputs pass `redact.ts`, which masks configured fields (**\[FILL: PII fields, e.g. tax IDs, bank details\]**) before anything reaches the model. Audit logs store query hashes, not result rows.
- **Best practice in scripts.** SuiteScript 2.1 only, `@NModuleScope SameAccount`, allow-listed record types, script IDs with an `nsagent` prefix, and no `N/http` calls out of NetSuite.

## Implementation guide

Ship read-only value first, then add writes behind approval, then publish to NetSuite's own AI Connector. Five phases, each ending in something usable.

### Phase 0: Account preparation

In a sandbox, enable REST Web Services, Server SuiteScript, SuiteCloud Development Framework and OAuth 2.0. Create the integration record with the client credentials grant, upload the public certificate, and map it to the dedicated integration role. Under Integration Governance, allocate a concurrency slice for this integration and record it as `NS_MAX_CONCURRENCY`. Install Oracle's MCP Standard Tools SuiteApp if you want its standard report and record tools available alongside ours. Put the private key in the secrets backend before anyone writes code.

### Phase 1: Foundation and data explorer

Scaffold the pnpm workspace and build `packages/ns-client` first: token caching, the limiter, retries, and the SuiteQL keyset pager. Add the metadata catalog cache, then the data-explorer tools (`ns_catalog_list`, `ns_record_describe`, `ns_suiteql`, `ns_record_get`). Record sandbox responses as contract tests so CI runs without network access. Exit check: an agent can answer "which customers have open invoices over 60 days?" using only read tools, with no throttling errors under a parallel load test at your concurrency cap.

### Phase 2: Searches and reports

Deploy the search RESTlet through SDF and wire `ns_search_preview`. Add the approval service and `ns_search_save`, writing searches only with the `customsearch_nsagent_` prefix. In parallel, build `report-engine` with three or four high-value definitions agreed with finance (**\[FILL: priority reports\]**) and CSV/XLSX exports. Route standard reports to the Standard Tools report tool rather than recreating them. Build the data importer here too, in dry-run-only mode at first; enable writes once a sandbox import reconciles row for row.

### Phase 3: Schema changes through SDF

Build `sdf-gen` for the custom field types you need and the `advancedpdftemplate` object, plus the PDF preview RESTlet. Wire the change-control flow: the agent writes XML, opens a pull request, CI runs `suitecloud project:validate` against the sandbox, a reviewer approves, and `deploy-sdf.yml` deploys to sandbox and then, after a second approval, to production. Rollback is a revert PR. This is slower than live edits by design: field and template changes affect every user and every downstream integration.

### Phase 4: AI Connector custom tools

Package the read tools that matter most as custom tool scripts (`N/query` only) with JSON schemas and the SDF tool object, deployed as an account customization project. Any MCP client connected to the account's AI Connector endpoint can then use them under the integration role's permissions, without running the gateway. Keep the gateway for anything that needs the limiter, approvals or file exports.

### Phase 5: Hardening

Add PII redaction rules, audit log retention, alerting on rejected-request ratio, and a quarterly review of the integration role's permissions. Track release notes for each NetSuite release; the SOAP retirement and TBA cutoff do not affect this design, but SuiteQL table and field changes can.

### Extending later

A new capability is one new skill folder, one tool file in the gateway, and, if it needs server-side code, one RESTlet or custom tool in `netsuite/`. Nothing in the core packages changes, which keeps governance and security uniform as the agent grows.

## Execution checklist and open inputs

All five checklist items are covered in this design; the open inputs below need answers before Phase 1 starts.

- [x] All required capabilities covered: searches, custom fields, PDFs, reports, data view, data import (skills table and sample code)
- [x] Repository structure clear and logical (repository layout)
- [x] Placeholders included for missing inputs (list below)
- [x] No credentials hard-coded: private key from the secrets backend, IDs from environment, secret scanning in CI
- [x] Reviewed against NetSuite API limits (limits table)

Open inputs:

| Placeholder | Needed for | Owner |
| --- | --- | --- |
| \[FILL: current repo layout\] | Merging into an existing monorepo instead of a new one | \[FILL\] |
| \[FILL: NetSuite API documentation\] | `docs/netsuite-api/`, pinned to your account's release | \[FILL\] |
| \[FILL: example repository or similar project\] | Reference implementation; Oracle's SuiteCloud Project Repository on GitHub has MCP sample tools ([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_1185045525.html)) | \[FILL\] |
| \[FILL: NetSuite integration guide\] | Team conventions for roles, naming, deployment windows | \[FILL\] |
| \[FILL: secrets backend\] | Storing the M2M private key | \[FILL\] |
| \[FILL: allowed record types\] | Search RESTlet allow-list | \[FILL\] |
| \[FILL: PII fields\] | Redaction rules | \[FILL\] |
| \[FILL: priority reports\] | First report definitions in Phase 2 | \[FILL\] |
| \[FILL: service tier and SuiteCloud Plus count\] | Sizing `NS_MAX_CONCURRENCY` | \[FILL\] |
| \[FILL: custom tool SDF object type\] | Exact object name and attributes per the SDF reference | \[FILL\] |
| \[FILL: import row threshold and importable record types\] | Choosing REST upsert vs CSV import task; importer allow-list | \[FILL\] |
| \[FILL: agreed eval thresholds, canary and retirement days\] | Skill acceptance and lifecycle rules | \[FILL\] |

### Sources

- [MCP Standard Tools SuiteApp](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_143403258.html) (Oracle)
- [Creating Custom Tools for the NetSuite AI Connector Service](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_162020236.html) (Oracle)
- [SuiteScript 2.1 Custom Tool Script Type](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/T_article_1185045525_1.html) (Oracle)
- [Executing SuiteQL Queries Through REST Web Services](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157909186990.html) (Oracle)
- [SuiteQL.runPaged(options)](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157960491275.html) (Oracle)
- [Augment NetSuite REST functionality with RESTlets](https://blogs.oracle.com/developers/augment-netsuite-rest-functionality-with-restlet) (Oracle developers blog)
- [NetSuite 2026.1: critical changes clients must address now](https://technologyblog.rsmus.com/technologies/netsuite/netsuite-2026-1-critical-changes-clients-must-address-now/) (RSM)
- [NetSuite concurrency governance](https://docs.jitterbit.com/integration-studio/design/connectors/netsuite/netsuite-troubleshooting/concurrency-governance/) (Jitterbit)
- [NetSuite API vs SKU.io](https://www.sku.io/netsuite-api-vs-sku-io/) (summary of Oracle's tier limits)
- [NetSuite MCP connector setup](https://www.anchorgroup.tech/blog/netsuite-mcp-connector) (Anchor Group)
- [NetSuite MCP: what it is and how to set it up](https://www.numeric.io/blog/netsuite-mcp) (Numeric)
