import { collect, suiteqlOffset, type NsRequester } from "@ns-agent/ns-client";
import type { ReportDefinition } from "./definition";
import type { ReportRow } from "./csv";
import { bindParams, type ParamValues } from "./params";

export interface ReportResult {
  query: string;
  rows: ReportRow[];
  /** True when more rows existed than maxRows; the file holds the first maxRows. */
  truncated: boolean;
}

/** Binds the definition's parameters, then pages through the results (offset paging, up to maxRows). */
export async function runReport(
  ns: NsRequester,
  def: ReportDefinition,
  values: ParamValues,
  options: { maxRows?: number; pageSize?: number } = {},
): Promise<ReportResult> {
  const query = bindParams(def, values);
  const maxRows = Math.min(options.maxRows ?? def.maxRows, def.maxRows);
  const rows = await collect(suiteqlOffset<ReportRow>(ns, query, { pageSize: options.pageSize }), maxRows + 1);
  const truncated = rows.length > maxRows;
  return { query, rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
}
