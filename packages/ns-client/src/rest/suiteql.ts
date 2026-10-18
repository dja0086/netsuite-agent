import type { NsRequester } from "../http";
import { stripLinks } from "../strip-links";

/** REST web services return at most 1,000 rows per page. */
export const SUITEQL_MAX_PAGE = 1000;
/** Offset paging stops at 100,000 results unless SuiteAnalytics Connect is enabled. */
export const SUITEQL_MAX_RESULTS = 100_000;

export type Row = Record<string, unknown>;

export interface SuiteQLPage<T = Row> {
  items: T[];
  hasMore: boolean;
  count: number;
  offset: number;
  totalResults: number;
}

interface RawPage {
  items?: Row[];
  hasMore?: boolean;
  count?: number;
  offset?: number;
  totalResults?: number;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Runs one page of a SuiteQL query through REST web services. */
export async function suiteql<T = Row>(
  ns: NsRequester,
  q: string,
  options: { limit?: number; offset?: number } = {},
): Promise<SuiteQLPage<T>> {
  const limit = options.limit ?? SUITEQL_MAX_PAGE;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > SUITEQL_MAX_PAGE) {
    throw new Error(`SuiteQL limit must be 1..${SUITEQL_MAX_PAGE}, got ${limit}`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`SuiteQL offset must be >= 0, got ${offset}`);

  const raw = await ns.request<RawPage>({
    method: "POST",
    base: "rest",
    path: "/services/rest/query/v1/suiteql",
    query: { limit, offset },
    headers: { Prefer: "transient" },
    body: { q },
  });
  const items = stripLinks(raw.items ?? []) as T[];
  return {
    items,
    hasMore: Boolean(raw.hasMore),
    count: raw.count ?? items.length,
    offset: raw.offset ?? offset,
    totalResults: raw.totalResults ?? items.length,
  };
}

/**
 * Streams every row of a query using keyset paging on a numeric key column.
 * Each request is a fresh small query, so the 100,000-result offset cap never applies.
 */
export async function* suiteqlAll<T extends Row = Row>(
  ns: NsRequester,
  sql: string,
  options: { key?: string; pageSize?: number } = {},
): AsyncGenerator<T> {
  const key = (options.key ?? "id").toLowerCase();
  if (!IDENTIFIER.test(key)) throw new Error(`Invalid key column: ${key}`);
  const pageSize = options.pageSize ?? SUITEQL_MAX_PAGE;
  let last: number | undefined;

  for (;;) {
    const where = last === undefined ? "" : ` WHERE q.${key} > ${last}`;
    const page = await suiteql<T>(ns, `SELECT * FROM (${sql}) q${where} ORDER BY q.${key}`, { limit: pageSize });
    if (page.items.length === 0) return;
    yield* page.items;

    const tail = Number(page.items.at(-1)?.[key]);
    if (!Number.isFinite(tail)) throw new Error(`Keyset column "${key}" is missing or not numeric in the results`);
    if (last !== undefined && tail <= last) throw new Error(`Keyset paging did not advance past ${last}`);
    last = tail;
    if (page.items.length < pageSize) return;
  }
}

/** Offset paging, for grouped or small result sets that have no numeric key. Stops at the 100,000-row cap. */
export async function* suiteqlOffset<T = Row>(
  ns: NsRequester,
  sql: string,
  options: { pageSize?: number } = {},
): AsyncGenerator<T> {
  const pageSize = options.pageSize ?? SUITEQL_MAX_PAGE;
  for (let offset = 0; ; offset += pageSize) {
    if (offset >= SUITEQL_MAX_RESULTS) {
      throw new Error(`Result exceeds ${SUITEQL_MAX_RESULTS} rows; use suiteqlAll (keyset paging) instead`);
    }
    const page = await suiteql<T>(ns, sql, { limit: pageSize, offset });
    yield* page.items;
    if (!page.hasMore) return;
  }
}

/** Collects an async iterable into an array, stopping at `max` items. */
export async function collect<T>(source: AsyncIterable<T>, max = Number.POSITIVE_INFINITY): Promise<T[]> {
  const out: T[] = [];
  for await (const item of source) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}
