import { createHash } from "node:crypto";

/**
 * Flux arithmetic, in code so that every number on the screen is computed, never written by a model.
 * All "natural" amounts read as a statement does: income and expense both positive. "Impact" is the effect on
 * net income, which is what favourable and unfavourable mean.
 */
export type AcctType = "Income" | "COGS" | "Expense" | "OthIncome" | "OthExpense";
export const ACCT_TYPES: readonly AcctType[] = ["Income", "COGS", "Expense", "OthIncome", "OthExpense"];
const isIncome = (t: AcctType) => t === "Income" || t === "OthIncome";

export const natural = (type: AcctType, ledgerAmount: number) => (isIncome(type) ? -ledgerAmount : ledgerAmount);
export const impactOf = (type: AcctType, delta: number) => (isIncome(type) ? delta : -delta);
/** Percent change, or null where it means nothing: a zero or negative base (IBCS "n.a."). */
export const pctChange = (cur: number, prior: number) => (prior > 0 ? (cur - prior) / prior : null);

export interface SubRow {
  accountId: number;
  account: string;
  type: AcctType;
  subsidiaryId: number;
  subsidiary: string;
  /** Ledger signs, as NetSuite returns them. */
  localCur: number;
  localPrior: number;
  usdCur: number;
  usdPrior: number;
  lines: number;
}

export interface Policy {
  amount: number;
  percent: number;
  mode: "either" | "both";
  /** Flagged at this size whatever the percent: a large move on a large base must not slip through "both". */
  alwaysAmount?: number;
  overrides: Record<string, { amount?: number; percent?: number }>;
}
export const DEFAULT_POLICY: Policy = { amount: 50_000, percent: 0.1, mode: "both", alwaysAmount: 250_000, overrides: {} };

export type Rates = Record<string, { cur: number | null; prior: number | null }>;

export interface SubFlux {
  subsidiaryId: number;
  subsidiary: string;
  cur: number;
  prior: number;
  delta: number;
  activity: number;
  fx: number;
  other: number;
}

export interface AccountFlux {
  accountId: number;
  account: string;
  type: AcctType;
  cur: number;
  prior: number;
  delta: number;
  pct: number | null;
  impact: number;
  /** Change at the comparison period's rates, the rate effect, and whatever those two leave over. Always sums to delta. */
  activity: number;
  fx: number;
  other: number;
  lines: number;
  subsidiaries: SubFlux[];
  flagged: boolean;
  flagReason: string | null;
  ledgerHash: string;
}

/** Whether a movement needs an explanation. On a base with no meaningful percent, only the amount can be tested. */
export function flagFor(accountId: number, delta: number, pct: number | null, policy: Policy): { flagged: boolean; reason: string | null } {
  const o = policy.overrides[String(accountId)] ?? {};
  const amount = o.amount ?? policy.amount;
  const percent = o.percent ?? policy.percent;
  const overAmount = Math.abs(delta) >= amount;
  if (policy.alwaysAmount !== undefined && Math.abs(delta) >= policy.alwaysAmount) return { flagged: true, reason: "Large amount" };
  if (pct === null) return { flagged: overAmount, reason: overAmount ? "Amount (no percent on this base)" : null };
  const overPercent = Math.abs(pct) >= percent;
  const flagged = policy.mode === "both" ? overAmount && overPercent : overAmount || overPercent;
  if (!flagged) return { flagged, reason: null };
  return { flagged, reason: overAmount && overPercent ? "Amount and percent" : overAmount ? "Amount" : "Percent" };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A fingerprint of an account's ledger state: if it changes, an explanation written against it is out of date. */
export function ledgerHash(rows: SubRow[]): string {
  const canon = rows
    .slice()
    .sort((a, b) => a.subsidiaryId - b.subsidiaryId)
    .map((r) => [r.subsidiaryId, round2(r.usdCur), round2(r.usdPrior), r.lines].join(":"))
    .join("|");
  return createHash("sha256").update(canon).digest("hex").slice(0, 16);
}

/** Splits one subsidiary's movement into activity (local change at prior rate) and FX (current amount times the rate change). */
function subFlux(r: SubRow, rates: Rates): SubFlux {
  const cur = natural(r.type, r.usdCur);
  const prior = natural(r.type, r.usdPrior);
  const delta = cur - prior;
  const rate = rates[String(r.subsidiaryId)];
  if (!rate || rate.cur === null || rate.prior === null) {
    return { subsidiaryId: r.subsidiaryId, subsidiary: r.subsidiary, cur, prior, delta, activity: 0, fx: 0, other: delta };
  }
  const localCur = natural(r.type, r.localCur);
  const localPrior = natural(r.type, r.localPrior);
  const activity = (localCur - localPrior) * rate.prior;
  const fx = localCur * (rate.cur - rate.prior);
  return { subsidiaryId: r.subsidiaryId, subsidiary: r.subsidiary, cur, prior, delta, activity, fx, other: delta - activity - fx };
}

export function accountFlux(rows: SubRow[], rates: Rates, policy: Policy): AccountFlux[] {
  const groups = new Map<number, SubRow[]>();
  for (const r of rows) groups.set(r.accountId, [...(groups.get(r.accountId) ?? []), r]);
  const out: AccountFlux[] = [];
  for (const [accountId, group] of groups) {
    const first = group[0]!;
    const subsidiaries = group.map((r) => subFlux(r, rates)).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const sum = (f: (s: SubFlux) => number) => subsidiaries.reduce((t, s) => t + f(s), 0);
    const cur = sum((s) => s.cur);
    const prior = sum((s) => s.prior);
    const delta = cur - prior;
    const pct = pctChange(cur, prior);
    const flag = flagFor(accountId, delta, pct, policy);
    out.push({
      accountId,
      account: first.account,
      type: first.type,
      cur,
      prior,
      delta,
      pct,
      impact: impactOf(first.type, delta),
      activity: sum((s) => s.activity),
      fx: sum((s) => s.fx),
      other: sum((s) => s.other),
      lines: group.reduce((t, r) => t + r.lines, 0),
      subsidiaries,
      flagged: flag.flagged,
      flagReason: flag.reason,
      ledgerHash: ledgerHash(group),
    });
  }
  return out.sort((a, b) => a.account.localeCompare(b.account));
}

export interface Line {
  cur: number;
  prior: number;
  delta: number;
  pct: number | null;
}
const line = (cur: number, prior: number): Line => ({ cur, prior, delta: cur - prior, pct: pctChange(cur, prior) });

export interface Statement {
  revenue: Line;
  cogs: Line;
  grossMargin: Line;
  expense: Line;
  operatingIncome: Line;
  other: Line;
  netIncome: Line;
}

export function statement(accounts: AccountFlux[]): Statement {
  const total = (types: AcctType[], pick: "cur" | "prior") => accounts.filter((a) => types.includes(a.type)).reduce((t, a) => t + a[pick], 0);
  const both = (types: AcctType[]) => line(total(types, "cur"), total(types, "prior"));
  const revenue = both(["Income"]);
  const cogs = both(["COGS"]);
  const expense = both(["Expense"]);
  const othInc = both(["OthIncome"]);
  const othExp = both(["OthExpense"]);
  const grossMargin = line(revenue.cur - cogs.cur, revenue.prior - cogs.prior);
  const operatingIncome = line(grossMargin.cur - expense.cur, grossMargin.prior - expense.prior);
  const other = line(othInc.cur - othExp.cur, othInc.prior - othExp.prior);
  return { revenue, cogs, grossMargin, expense, operatingIncome, other, netIncome: line(operatingIncome.cur + other.cur, operatingIncome.prior + other.prior) };
}

export interface ControlRow {
  periodId: number;
  type: AcctType;
  usd: number;
}

/** Compares our sum (built through subsidiary lines) with an independent ledger total. Largest gap across types and periods. */
export function tieOut(accounts: AccountFlux[], control: ControlRow[], curId: number, priorId: number): { ties: boolean; difference: number } {
  let difference = 0;
  for (const [periodId, pick] of [[curId, "cur"], [priorId, "prior"]] as const) {
    for (const type of ACCT_TYPES) {
      const ours = accounts.filter((a) => a.type === type).reduce((t, a) => t + a[pick], 0);
      const row = control.find((c) => c.periodId === periodId && c.type === type);
      const ledger = row ? natural(type, row.usd) : 0;
      if (Math.abs(ours - ledger) > Math.abs(difference)) difference = ours - ledger;
    }
  }
  return { ties: Math.abs(difference) < 0.01, difference };
}

export interface BridgeStep {
  label: string;
  accountId: number | null;
  impact: number;
  kind: "account" | "other_up" | "other_down";
  count?: number;
}

/** Net income walk: the largest movers by name, the rest split into gross up and gross down so offsets stay visible. */
export function bridge(accounts: AccountFlux[], topN = 8): { start: number; end: number; steps: BridgeStep[] } {
  const movers = accounts.filter((a) => a.impact !== 0).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const steps: BridgeStep[] = movers.slice(0, topN).map((a) => ({ label: a.account, accountId: a.accountId, impact: a.impact, kind: "account" }));
  const rest = movers.slice(topN);
  const up = rest.filter((a) => a.impact > 0);
  const down = rest.filter((a) => a.impact < 0);
  if (up.length) steps.push({ label: "Other increases", accountId: null, impact: up.reduce((t, a) => t + a.impact, 0), kind: "other_up", count: up.length });
  if (down.length) steps.push({ label: "Other decreases", accountId: null, impact: down.reduce((t, a) => t + a.impact, 0), kind: "other_down", count: down.length });
  const ni = statement(accounts).netIncome;
  return { start: ni.prior, end: ni.cur, steps };
}

export interface Residual {
  count: number;
  net: number;
  grossUp: number;
  grossDown: number;
}

/** What the threshold let through, so unflagged movements can't quietly add up to something material. */
export function residual(accounts: AccountFlux[]): Residual {
  const below = accounts.filter((a) => !a.flagged);
  return {
    count: below.length,
    net: below.reduce((t, a) => t + a.impact, 0),
    grossUp: below.filter((a) => a.impact > 0).reduce((t, a) => t + a.impact, 0),
    grossDown: below.filter((a) => a.impact < 0).reduce((t, a) => t + a.impact, 0),
  };
}

export interface DimRow {
  accountId: number;
  dim: string | null;
  usdCur: number;
  usdPrior: number;
}

export interface DimValue {
  value: string;
  cur: number;
  prior: number;
  delta: number;
  /** Share of the account's change; can pass 100% when other values move the opposite way. */
  share: number | null;
  /** What the account's change would have been had this value stayed flat. */
  ifFlat: number;
}

export function rankDimension(account: AccountFlux, rows: DimRow[]): { values: DimValue[]; rest: number } {
  const values = rows
    .filter((r) => r.accountId === account.accountId)
    .map((r) => {
      const cur = natural(account.type, r.usdCur);
      const prior = natural(account.type, r.usdPrior);
      const delta = cur - prior;
      return { value: r.dim ?? "(none set)", cur, prior, delta, share: account.delta !== 0 ? delta / account.delta : null, ifFlat: account.delta - delta };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { values, rest: account.delta - values.reduce((t, v) => t + v.delta, 0) };
}

export interface Txn {
  accountId: number;
  periodId: number;
  id: number;
  tranid: string | null;
  type: string;
  date: string;
  entity: string | null;
  memo: string | null;
  subsidiary: string | null;
  lines: number;
  /** Natural sign, for this account in this period. */
  amount: number;
  /** Its effect on the change: current-period amounts add, comparison-period amounts subtract. */
  contribution: number;
}

export interface ExplanationDriver {
  label: string;
  cause: string;
  causeStatus: "stated_in_record" | "inferred" | "unknown";
  transactionIds: number[];
}

export interface PricedDriver extends ExplanationDriver {
  amount: number;
}

export interface Coverage {
  drivers: PricedDriver[];
  remainder: number;
  tracedPct: number;
  state: "traced" | "partly_traced" | "insufficient";
  /** Citations the model made to transactions it was never shown; dropped, and worth showing. */
  rejectedCitations: number[];
}

/**
 * Prices a model's drivers from the transactions they cite. The model chooses the grouping and the wording; the
 * amounts are always these sums, and whatever they leave of the change is shown as the remainder.
 */
export function coverage(delta: number, drivers: ExplanationDriver[], txns: Txn[]): Coverage {
  const known = new Map(txns.map((t) => [`${t.id}:${t.periodId}`, t]));
  const byId = new Map<number, Txn[]>();
  for (const t of txns) byId.set(t.id, [...(byId.get(t.id) ?? []), t]);
  const used = new Set<string>();
  const rejected: number[] = [];
  const priced: PricedDriver[] = drivers.map((d) => {
    const kept: number[] = [];
    let amount = 0;
    for (const id of d.transactionIds) {
      const matches = byId.get(id);
      if (!matches) {
        rejected.push(id);
        continue;
      }
      kept.push(id);
      for (const t of matches) {
        const key = `${t.id}:${t.periodId}`;
        if (used.has(key) || !known.has(key)) continue;
        used.add(key);
        amount += t.contribution;
      }
    }
    return { ...d, transactionIds: kept, amount };
  });
  const remainder = delta - priced.reduce((t, d) => t + d.amount, 0);
  const tracedPct = delta === 0 ? 1 : Math.max(0, 1 - Math.abs(remainder) / Math.abs(delta));
  const state = tracedPct >= 0.9 ? "traced" : tracedPct >= 0.5 ? "partly_traced" : "insufficient";
  return { drivers: priced, remainder, tracedPct, state, rejectedCitations: rejected };
}
