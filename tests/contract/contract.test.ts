/**
 * Replays recorded NetSuite responses (pnpm contracts:record) through ns-client.
 * When NetSuite changes a response shape, these fail before the agent breaks.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NsHttpError,
  getRecord,
  listRecordTypes,
  parseNsError,
  suiteql,
  summarizeSchema,
  type NsRequest,
  type NsRequester,
} from "@ns-agent/ns-client";

interface Fixture {
  name: string;
  request: Pick<NsRequest, "method" | "base" | "path" | "query" | "body">;
  status: number;
  response?: unknown;
  error?: { status: number; code?: string; message: string; body: unknown };
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixtures = new Map<string, Fixture>(
  (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : []).map((f) => {
    const fx = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as Fixture;
    return [fx.name, fx];
  }),
);

/** A requester that answers with one recorded fixture, raising recorded errors the way NsClient would. */
function replay(fx: Fixture): NsRequester {
  return {
    async request<T>(): Promise<T> {
      if (fx.error) throw parseNsError(fx.error.status, JSON.stringify(fx.error.body));
      return fx.response as T;
    },
  };
}

const has = (name: string) => fixtures.has(name);
const fx = (name: string) => fixtures.get(name)!;

describe.skipIf(fixtures.size === 0)("NetSuite contract (recorded responses)", () => {
  // SuiteQL over REST returns every value as a string, aggregates included.
  it.runIf(has("suiteql-count"))("SuiteQL aggregate returns one row with a string-encoded count", async () => {
    const page = await suiteql<{ n: string }>(replay(fx("suiteql-count")), "SELECT COUNT(id) AS n FROM customer", { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.n).toMatch(/^\d+$/);
    expect(page.items[0]).not.toHaveProperty("links");
  });

  it.runIf(has("suiteql-grouped"))("grouped SuiteQL with COUNT(t.id) and ORDER BY works", async () => {
    const page = await suiteql<{ type: string; n: string }>(replay(fx("suiteql-grouped")), "q", { limit: 100 });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items[0]).toEqual({ type: expect.any(String), n: expect.stringMatching(/^\d+$/) });
    const counts = page.items.map((r) => Number(r.n));
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it.runIf(has("suiteql-paged"))("paging fields are present and consistent", async () => {
    const page = await suiteql(replay(fx("suiteql-paged")), "q", { limit: 5, offset: 5 });
    expect(page.items.length).toBeLessThanOrEqual(5);
    expect(typeof page.hasMore).toBe("boolean");
    expect(page.offset).toBe(5);
    expect(page.totalResults).toBeGreaterThanOrEqual(page.items.length);
  });

  it.runIf(has("suiteql-error"))("SuiteQL errors parse into an NsHttpError with a code", async () => {
    const err = await suiteql(replay(fx("suiteql-error")), "q", { limit: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NsHttpError);
    expect((err as NsHttpError).status).toBe(400);
    expect((err as NsHttpError).code).toEqual(expect.any(String));
  });

  it.runIf(has("metadata-catalog"))("metadata catalog lists record type names", async () => {
    const types = await listRecordTypes(replay(fx("metadata-catalog")));
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(t).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  it.runIf(has("metadata-customer"))("record schema summarizes into typed fields", () => {
    const fields = summarizeSchema(fx("metadata-customer").response as Record<string, unknown>);
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f).toMatchObject({ id: expect.any(String), label: expect.any(String), type: expect.any(String) });
  });

  it.runIf(has("record-customer"))("record get returns the requested fields without links", async () => {
    const rec = await getRecord(replay(fx("record-customer")), "customer", "2784", { fields: ["companyname"] });
    expect(rec).toHaveProperty("id", "2784");
    expect(JSON.stringify(rec)).not.toContain('"links"');
  });

  it.runIf(has("record-missing"))("a missing record is a 404 NsHttpError", async () => {
    const err = await getRecord(replay(fx("record-missing")), "customer", "999999999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NsHttpError);
    expect((err as NsHttpError).status).toBe(404);
  });
});

describe("contract fixtures", () => {
  it("are present before a release (run pnpm contracts:record against the demo account)", () => {
    if (process.env.RELEASE_CHECK === "1") expect(fixtures.size).toBeGreaterThanOrEqual(6);
    else expect(true).toBe(true);
  });
});
