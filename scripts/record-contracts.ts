/**
 * pnpm contracts:record
 * Makes a fixed set of read-only calls against NS_ACCOUNT_ID (sandbox or demo only) and saves the raw
 * responses, sanitized, to tests/contract/fixtures. The contract tests replay them through ns-client so
 * a NetSuite API change shows up as a failing test instead of a broken agent.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NsClient, NsHttpError, accountHost, type NsRequest } from "@ns-agent/ns-client";
import { sanitize } from "./lib/sanitize";
import { requireLiveTarget } from "./lib/target";

const target = requireLiveTarget("contracts:record");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "tests/contract/fixtures");
const ns = NsClient.fromEnv();
const host = accountHost(ns.config.accountId);

export interface Fixture {
  name: string;
  recordedAt: string;
  target: string;
  request: Pick<NsRequest, "method" | "base" | "path" | "query" | "body">;
  status: number;
  response?: unknown;
  error?: { status: number; code?: string; message: string; body: unknown };
}

async function record(name: string, req: NsRequest, trim?: (r: unknown) => unknown): Promise<unknown> {
  const fixture: Fixture = {
    name,
    recordedAt: new Date().toISOString(),
    target,
    request: { method: req.method, base: req.base, path: req.path, query: req.query, body: req.body },
    status: 200,
  };
  let raw: unknown;
  try {
    raw = await ns.request(req);
    fixture.response = sanitize(trim ? trim(raw) : raw, host);
  } catch (error) {
    if (!(error instanceof NsHttpError)) throw error;
    let body: unknown = error.body;
    try {
      body = JSON.parse(error.body ?? "");
    } catch {
      /* keep text */
    }
    fixture.status = error.status;
    fixture.error = { status: error.status, code: error.code, message: error.message, body: sanitize(body, host) };
  }
  await writeFile(path.join(outDir, `${name}.json`), JSON.stringify(fixture, null, 2) + "\n");
  console.log(`recorded ${name} (HTTP ${fixture.status})`);
  return raw;
}

const suiteqlReq = (q: string, limit: number, offset = 0): NsRequest => ({
  method: "POST",
  base: "rest",
  path: "/services/rest/query/v1/suiteql",
  query: { limit, offset },
  headers: { Prefer: "transient" },
  body: { q },
});

const firstItems = (n: number) => (r: unknown) => {
  const obj = r as { items?: unknown[] };
  return { ...obj, items: obj.items?.slice(0, n) };
};

await mkdir(outDir, { recursive: true });

await record("suiteql-count", suiteqlReq("SELECT COUNT(id) AS n FROM customer", 1));
await record("suiteql-grouped", suiteqlReq("SELECT t.type, COUNT(t.id) AS n FROM transaction t GROUP BY t.type ORDER BY n DESC", 100));
await record("suiteql-paged", suiteqlReq("SELECT id FROM transaction ORDER BY id", 5, 5));
await record("suiteql-error", suiteqlReq("SELECT no_such_column FROM customer", 1));
await record("metadata-catalog", { method: "GET", base: "rest", path: "/services/rest/record/v1/metadata-catalog" }, firstItems(25));
await record(
  "metadata-customer",
  {
    method: "GET",
    base: "rest",
    path: "/services/rest/record/v1/metadata-catalog/customer",
    headers: { Accept: "application/schema+json" },
  },
  (r) => {
    // Keep the schema small: the first 40 properties are enough to test the parser.
    const schema = r as { properties?: Record<string, unknown> };
    return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties ?? {}).slice(0, 40)) };
  },
);

const idPage = (await ns.request(suiteqlReq("SELECT id FROM customer WHERE ROWNUM <= 1", 1))) as { items?: Array<{ id: string }> };
const customerId = idPage.items?.[0]?.id;
if (customerId) {
  await record("record-customer", {
    method: "GET",
    base: "rest",
    path: `/services/rest/record/v1/customer/${customerId}`,
    query: { fields: "companyname,subsidiary,balance" },
  });
}
await record("record-missing", { method: "GET", base: "rest", path: "/services/rest/record/v1/customer/999999999" });

console.log(`\nFixtures written to ${path.relative(repoRoot, outDir)}. Review the diff before committing.`);
