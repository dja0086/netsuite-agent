import type { AcctType } from "./engine";

/**
 * The fixed SuiteQL behind flux. Every value in these strings is an integer checked here or a constant, so nothing
 * typed by a person or a model reaches a query. Single lines: the reader must send them back character for character.
 */
const int = (n: number): number => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Not a valid NetSuite id: ${n}`);
  return n;
};
const ints = (list: number[]) => list.map(int).join(", ");

const PNL = "'Income','COGS','Expense','OthIncome','OthExpense'";
const usd = (root: number) => `TO_NUMBER(BUILTIN.CONSOLIDATE(tal.amount,'LEDGER','DEFAULT','DEFAULT',${int(root)},t.postingperiod,'DEFAULT'))`;
const when = (period: number, value: string) => `SUM(CASE WHEN t.postingperiod = ${int(period)} THEN ${value} ELSE 0 END)`;

export const periodsSql = () =>
  `SELECT t.postingperiod AS id, BUILTIN.DF(t.postingperiod) AS name, TO_CHAR(MIN(t.trandate),'YYYY-MM-DD') AS first_date, COUNT(t.id) AS lines FROM transactionaccountingline tal JOIN account a ON a.id = tal.account JOIN transaction t ON t.id = tal.transaction WHERE tal.posting = 'T' AND a.accttype IN (${PNL}) GROUP BY t.postingperiod, BUILTIN.DF(t.postingperiod) ORDER BY 3 DESC`;

export const rootSubsidiarySql = () => `SELECT s.id, s.name, BUILTIN.DF(s.currency) AS currency FROM subsidiary s WHERE s.parent IS NULL AND s.isinactive = 'F'`;

/** Split by account type group, since the tool returns at most 200 rows and SuiteQL here rejects paged subqueries. */
export const ACCOUNT_GROUPS: readonly AcctType[][] = [["Income", "OthIncome"], ["COGS"], ["Expense", "OthExpense"]];

export const accountSubsidiarySql = (cur: number, prior: number, root: number, types: AcctType[]) =>
  `SELECT tal.account AS account_id, BUILTIN.DF(tal.account) AS account, a.accttype, tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary, ${when(cur, "tal.amount")} AS local_cur, ${when(prior, "tal.amount")} AS local_prior, ${when(cur, usd(root))} AS usd_cur, ${when(prior, usd(root))} AS usd_prior, COUNT(t.id) AS lines FROM transactionaccountingline tal JOIN account a ON a.id = tal.account JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND a.accttype IN (${types.map((x) => `'${x}'`).join(",")}) AND t.postingperiod IN (${ints([cur, prior])}) GROUP BY tal.account, BUILTIN.DF(tal.account), a.accttype, tl.subsidiary, BUILTIN.DF(tl.subsidiary)`;

/** The independent total: no subsidiary line join, so a row lost or doubled by that join shows up as a difference. */
export const controlSql = (cur: number, prior: number, root: number) =>
  `SELECT t.postingperiod AS period_id, a.accttype, SUM(${usd(root)}) AS usd FROM transactionaccountingline tal JOIN account a ON a.id = tal.account JOIN transaction t ON t.id = tal.transaction WHERE tal.posting = 'T' AND a.accttype IN (${PNL}) AND t.postingperiod IN (${ints([cur, prior])}) GROUP BY t.postingperiod, a.accttype`;

export const ratesSql = (cur: number, prior: number, root: number) =>
  `SELECT r.fromsubsidiary AS subsidiary_id, MAX(CASE WHEN r.postingperiod = ${int(cur)} THEN r.averagerate END) AS rate_cur, MAX(CASE WHEN r.postingperiod = ${int(prior)} THEN r.averagerate END) AS rate_prior FROM consolidatedexchangerate r WHERE r.tosubsidiary = ${int(root)} AND r.postingperiod IN (${ints([cur, prior])}) GROUP BY r.fromsubsidiary`;

export const trendSql = (periods: number[], root: number) =>
  `SELECT tal.account AS account_id, ${periods.map((p) => `${when(p, usd(root))} AS p${int(p)}`).join(", ")} FROM transactionaccountingline tal JOIN account a ON a.id = tal.account JOIN transaction t ON t.id = tal.transaction WHERE tal.posting = 'T' AND a.accttype IN (${PNL}) AND t.postingperiod IN (${ints(periods)}) GROUP BY tal.account`;

export const DIMENSIONS = {
  department: { label: "Department", expr: "BUILTIN.DF(tl.department)" },
  class: { label: "Class", expr: "BUILTIN.DF(tl.class)" },
  location: { label: "Location", expr: "BUILTIN.DF(tl.location)" },
  counterparty: { label: "Client or vendor", expr: "CASE WHEN tl.entity IS NULL THEN BUILTIN.DF(t.entity) ELSE BUILTIN.DF(tl.entity) END" },
  item: { label: "Item", expr: "BUILTIN.DF(tl.item)" },
} as const;
export type DimensionKey = keyof typeof DIMENSIONS;
export const DIMENSION_KEYS = Object.keys(DIMENSIONS) as DimensionKey[];

export const dimensionSql = (dim: DimensionKey, cur: number, prior: number, root: number, accounts: number[], top: number) => {
  const expr = DIMENSIONS[dim].expr;
  return `SELECT * FROM (SELECT y.*, ROW_NUMBER() OVER (PARTITION BY y.account_id ORDER BY ABS(y.usd_cur - y.usd_prior) DESC) AS rk FROM (SELECT tal.account AS account_id, ${expr} AS dim, ${when(cur, usd(root))} AS usd_cur, ${when(prior, usd(root))} AS usd_prior FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND t.postingperiod IN (${ints([cur, prior])}) AND tal.account IN (${ints(accounts)}) GROUP BY tal.account, ${expr}) y) WHERE rk <= ${int(top)}`;
};

export const transactionsSql = (cur: number, prior: number, root: number, accounts: number[], top: number) =>
  `SELECT * FROM (SELECT y.*, ROW_NUMBER() OVER (PARTITION BY y.account_id, y.period_id ORDER BY ABS(y.usd) DESC) AS rk FROM (SELECT tal.account AS account_id, t.postingperiod AS period_id, t.id AS txn_id, t.tranid, t.type, TO_CHAR(t.trandate,'YYYY-MM-DD') AS trandate, BUILTIN.DF(t.entity) AS entity, t.memo, MAX(tl.memo) AS line_memo, BUILTIN.DF(t.subsidiary) AS subsidiary, COUNT(t.id) AS lines, SUM(${usd(root)}) AS usd FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting = 'T' AND t.postingperiod IN (${ints([cur, prior])}) AND tal.account IN (${ints(accounts)}) GROUP BY tal.account, t.postingperiod, t.id, t.tranid, t.type, TO_CHAR(t.trandate,'YYYY-MM-DD'), BUILTIN.DF(t.entity), t.memo, BUILTIN.DF(t.subsidiary)) y) WHERE rk <= ${int(top)}`;
