import { describe, expect, it } from "vitest";
import { collect, suiteql, suiteqlAll, suiteqlOffset, type NsRequest, type NsRequester } from "../src";

/** Fake requester backed by an in-memory table of rows with ids 1..n. */
function fakeTable(n: number) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `row ${i + 1}`, links: [{ rel: "self" }] }));
  const requests: NsRequest[] = [];
  const ns: NsRequester = {
    async request<T>(req: NsRequest): Promise<T> {
      requests.push(req);
      const q = (req.body as { q: string }).q;
      const limit = Number(req.query?.limit);
      const offset = Number(req.query?.offset);
      const after = /> (-?\d+)/.exec(q);
      const filtered = after ? rows.filter((r) => r.id > Number(after[1])) : rows;
      const items = filtered.slice(offset, offset + limit);
      return {
        items,
        count: items.length,
        offset,
        hasMore: offset + limit < filtered.length,
        totalResults: filtered.length,
      } as T;
    },
  };
  return { ns, requests };
}

describe("suiteql", () => {
  it("posts the query with the transient preference and strips links", async () => {
    const { ns, requests } = fakeTable(3);
    const page = await suiteql(ns, "SELECT id FROM customer", { limit: 2 });
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/services/rest/query/v1/suiteql",
      headers: { Prefer: "transient" },
      query: { limit: 2, offset: 0 },
    });
    expect(page.items[0]).toEqual({ id: 1, name: "row 1" });
    expect(page.hasMore).toBe(true);
  });

  it("rejects page sizes above 1,000", async () => {
    const { ns } = fakeTable(1);
    await expect(suiteql(ns, "SELECT 1 FROM DUAL", { limit: 1001 })).rejects.toThrow(/limit/);
  });
});

describe("suiteqlAll (keyset paging)", () => {
  it("returns every row in order with small queries", async () => {
    const { ns, requests } = fakeTable(2500);
    const rows = await collect(suiteqlAll(ns, "SELECT id, name FROM customer"));
    expect(rows).toHaveLength(2500);
    expect(rows.at(-1)).toMatchObject({ id: 2500 });
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.query?.offset === 0)).toBe(true);
    expect((requests[1]!.body as { q: string }).q).toContain("WHERE q.id > 1000 ORDER BY q.id");
  });

  it("rejects an unsafe key column", async () => {
    const { ns } = fakeTable(1);
    await expect(collect(suiteqlAll(ns, "SELECT 1", { key: "id; DROP" }))).rejects.toThrow(/Invalid key/);
  });
});

describe("suiteqlOffset", () => {
  it("walks pages until hasMore is false", async () => {
    const { ns, requests } = fakeTable(1500);
    const rows = await collect(suiteqlOffset(ns, "SELECT id FROM customer"));
    expect(rows).toHaveLength(1500);
    expect(requests.map((r) => r.query?.offset)).toEqual([0, 1000]);
  });
});
