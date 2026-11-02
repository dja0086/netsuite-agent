import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, accountFlux, bridge, coverage, flagFor, ledgerHash, pctChange, rankDimension, residual, statement, tieOut, type SubRow, type Txn } from "../src/flux/engine";
import { hasFigures } from "../src/flux/explain";
import { DIMENSION_KEYS, accountSubsidiarySql, dimensionSql, transactionsSql } from "../src/flux/queries";
import { resultsFromEvents } from "../src/flux/reader";
import { applyAction, reconcileWorkflowEntries, toTxns, type Workflow } from "../src/flux/service";

const row = (over: Partial<SubRow>): SubRow => ({
  accountId: 1,
  account: "6390 Rent",
  type: "Expense",
  subsidiaryId: 1,
  subsidiary: "US",
  localCur: 0,
  localPrior: 0,
  usdCur: 0,
  usdPrior: 0,
  lines: 1,
  ...over,
});
const txn = (over: Partial<Txn>): Txn => ({ accountId: 1, periodId: 2, id: 1, tranid: null, type: "Journal", date: "2017-07-01", entity: null, memo: null, subsidiary: null, lines: 1, amount: 0, contribution: 0, ...over });
const wf = (over: Partial<Workflow> = {}): Workflow => ({ state: "open", draft: null, text: null, guidance: null, draftError: null, stale: false, ledgerHash: "h", priorExplanation: null, history: [], ...over });
const draftFixture = { summary: "s", drivers: [], questionForOwner: null, recurrence: "no_prior" as const };

describe("flags", () => {
  const policy = { ...DEFAULT_POLICY, amount: 1000, percent: 0.1, mode: "either" as const };
  it("flags on either amount or percent in either mode", () => {
    expect(flagFor(1, 2000, 0.01, policy).flagged).toBe(true);
    expect(flagFor(1, 500, 0.5, policy).flagged).toBe(true);
    expect(flagFor(1, 500, 0.01, policy).flagged).toBe(false);
  });
  it("needs both in both mode", () => {
    expect(flagFor(1, 2000, 0.01, { ...policy, mode: "both" }).flagged).toBe(false);
    expect(flagFor(1, 2000, 0.2, { ...policy, mode: "both" }).flagged).toBe(true);
  });
  it("tests only the amount where no percent exists, so a new account can't be flagged on a meaningless percent", () => {
    expect(flagFor(1, 500, null, policy).flagged).toBe(false);
    expect(flagFor(1, 1500, null, policy).reason).toContain("no percent");
  });
  it("always flags a large move, even under the percent in both mode", () => {
    const both = { ...policy, mode: "both" as const, alwaysAmount: 100_000 };
    expect(flagFor(1, 793_099, 0.05, both)).toEqual({ flagged: true, reason: "Large amount" });
    expect(flagFor(1, 99_000, 0.05, both).flagged).toBe(false);
  });
  it("honours a per-account override", () => {
    expect(flagFor(7, 500, 0.01, { ...policy, overrides: { "7": { amount: 100 } } }).flagged).toBe(true);
  });
  it("gives no percent on a zero or negative base", () => {
    expect(pctChange(10, 0)).toBeNull();
    expect(pctChange(10, -5)).toBeNull();
    expect(pctChange(15, 10)).toBeCloseTo(0.5);
  });
});

describe("account flux", () => {
  it("reads income and expense naturally and treats impact on profit as favourable or not", () => {
    const [income] = accountFlux([row({ accountId: 2, account: "4000", type: "Income", usdCur: -120, usdPrior: -100, localCur: -120, localPrior: -100 })], {}, DEFAULT_POLICY);
    expect(income).toMatchObject({ cur: 120, prior: 100, delta: 20, impact: 20 });
    const [expense] = accountFlux([row({ usdCur: 120, usdPrior: 100, localCur: 120, localPrior: 100 })], {}, DEFAULT_POLICY);
    expect(expense).toMatchObject({ delta: 20, impact: -20 });
  });
  it("splits activity from FX, and the pieces add back to the change", () => {
    // 1,000 local at 1.10 last period, 1,200 local at 1.20 now.
    const rows = [row({ subsidiaryId: 5, localCur: 1200, localPrior: 1000, usdCur: 1440, usdPrior: 1100 })];
    const [a] = accountFlux(rows, { "5": { cur: 1.2, prior: 1.1 } }, DEFAULT_POLICY);
    expect(a!.activity).toBeCloseTo(220);
    expect(a!.fx).toBeCloseTo(120);
    expect(a!.other).toBeCloseTo(0);
    expect(a!.activity + a!.fx + a!.other).toBeCloseTo(a!.delta);
  });
  it("puts a change with no known rate in other rather than guessing", () => {
    const [a] = accountFlux([row({ subsidiaryId: 9, usdCur: 50, usdPrior: 10 })], {}, DEFAULT_POLICY);
    expect(a).toMatchObject({ activity: 0, fx: 0, other: 40 });
  });
  it("changes the ledger fingerprint when a posting changes", () => {
    const a = ledgerHash([row({ usdCur: 100 })]);
    expect(ledgerHash([row({ usdCur: 100 })])).toBe(a);
    expect(ledgerHash([row({ usdCur: 100.5 })])).not.toBe(a);
    expect(ledgerHash([row({ usdCur: 100, lines: 2 })])).not.toBe(a);
  });
});

describe("statement, bridge and tie-out", () => {
  const rows = [
    row({ accountId: 1, account: "4000 Sales", type: "Income", usdCur: -1000, usdPrior: -800 }),
    row({ accountId: 2, account: "5000 COGS", type: "COGS", usdCur: 400, usdPrior: 300 }),
    row({ accountId: 3, account: "6000 Rent", type: "Expense", usdCur: 100, usdPrior: 150 }),
    row({ accountId: 4, account: "7000 Interest", type: "OthExpense", usdCur: 10, usdPrior: 5 }),
    row({ accountId: 5, account: "6100 Travel", type: "Expense", usdCur: 3, usdPrior: 1 }),
  ];
  const accounts = accountFlux(rows, {}, DEFAULT_POLICY);
  it("builds the statement", () => {
    const s = statement(accounts);
    expect(s.grossMargin.cur).toBe(600);
    expect(s.operatingIncome.cur).toBe(497);
    expect(s.netIncome.cur).toBe(487);
    expect(s.netIncome.prior).toBe(344);
  });
  it("walks the bridge from start to end exactly", () => {
    const b = bridge(accounts, 2);
    expect(b.steps.reduce((t, s) => b.start === 0 ? t : t + s.impact, b.start)).toBeCloseTo(b.end);
    expect(b.steps.filter((s) => s.kind === "account")).toHaveLength(2);
  });
  it("keeps offsets visible instead of netting them into one Other", () => {
    const b = bridge(accounts, 1);
    expect(b.steps.some((s) => s.kind === "other_up")).toBe(true);
    expect(b.steps.some((s) => s.kind === "other_down")).toBe(true);
  });
  it("reports what the threshold let through", () => {
    const small = accountFlux(rows, {}, { ...DEFAULT_POLICY, amount: 1e9, percent: 100, alwaysAmount: 1e9 });
    expect(residual(small).count).toBe(5);
    expect(residual(small).net).toBeCloseTo(statement(small).netIncome.delta);
  });
  it("ties to an independent total, and shows the gap when it doesn't", () => {
    const control = [
      { periodId: 2, type: "Income" as const, usd: -1000 }, { periodId: 2, type: "COGS" as const, usd: 400 }, { periodId: 2, type: "Expense" as const, usd: 103 }, { periodId: 2, type: "OthExpense" as const, usd: 10 },
      { periodId: 1, type: "Income" as const, usd: -800 }, { periodId: 1, type: "COGS" as const, usd: 300 }, { periodId: 1, type: "Expense" as const, usd: 151 }, { periodId: 1, type: "OthExpense" as const, usd: 5 },
    ];
    expect(tieOut(accounts, control, 2, 1).ties).toBe(true);
    const off = control.map((c) => (c.periodId === 2 && c.type === "COGS" ? { ...c, usd: 450 } : c));
    expect(tieOut(accounts, off, 2, 1)).toMatchObject({ ties: false, difference: -50 });
  });
});

describe("dimension ranking", () => {
  const [a] = accountFlux([row({ usdCur: 300, usdPrior: 100 })], {}, DEFAULT_POLICY);
  it("ranks by size, gives share and the what-if, and shows what is not listed", () => {
    const { values, rest } = rankDimension(a!, [
      { accountId: 1, dim: "Sales", usdCur: 280, usdPrior: 40 },
      { accountId: 1, dim: null, usdCur: 0, usdPrior: 50 },
      { accountId: 2, dim: "Elsewhere", usdCur: 999, usdPrior: 0 },
    ]);
    expect(values[0]).toMatchObject({ value: "Sales", delta: 240, share: 1.2, ifFlat: -40 });
    expect(values[1]!.value).toBe("(none set)");
    expect(rest).toBeCloseTo(200 - 190);
  });
});

describe("evidence coverage", () => {
  const txns = [txn({ id: 10, contribution: 800 }), txn({ id: 11, periodId: 1, contribution: -300 }), txn({ id: 12, contribution: 50 })];
  const driver = (ids: number[]) => ({ label: "x", cause: "y", causeStatus: "inferred" as const, transactionIds: ids });
  it("prices drivers from cited transactions, and the remainder makes up the difference", () => {
    const c = coverage(1000, [driver([10]), driver([11])], txns);
    expect(c.drivers.map((d) => d.amount)).toEqual([800, -300]);
    expect(c.remainder).toBe(500);
    expect(c.tracedPct).toBeCloseTo(0.5);
    expect(c.state).toBe("partly_traced");
  });
  it("refuses citations to transactions the model was never shown", () => {
    const c = coverage(800, [driver([10, 999])], txns);
    expect(c.drivers[0]!.transactionIds).toEqual([10]);
    expect(c.rejectedCitations).toEqual([999]);
    expect(c.state).toBe("traced");
  });
  it("does not count one transaction twice", () => {
    expect(coverage(800, [driver([10]), driver([10])], txns).drivers.map((d) => d.amount)).toEqual([800, 0]);
  });
  it("calls it insufficient with no drivers", () => {
    expect(coverage(1000, [], txns)).toMatchObject({ remainder: 1000, tracedPct: 0, state: "insufficient" });
  });
});

describe("explanation text", () => {
  it("catches figures in prose but allows references", () => {
    for (const bad of ["up $5,000", "rose 12%", "about 1,200,000", "2.5 million", "around 3.75"]) expect(hasFigures(bad)).toBe(true);
    for (const ok of ["Journal 602 imports the income statement", "Vendor Invoices in July", "the 2017 lease"]) expect(hasFigures(ok)).toBe(false);
  });
});

describe("queries", () => {
  it("refuses anything but a plain positive id, so no text can reach SQL", () => {
    expect(() => accountSubsidiarySql(1.5, 2, 11, ["Income"])).toThrow();
    expect(() => transactionsSql(1, 2, 11, [0], 8)).toThrow();
    expect(() => dimensionSql("item", 1, 2, 11, [Number("1; DROP")], 8)).toThrow();
  });
  it("is one line, because the reader must return it exactly", () => {
    for (const key of DIMENSION_KEYS) expect(dimensionSql(key, 1, 2, 11, [3], 8)).not.toContain("\n");
  });
});

describe("reading results from session events", () => {
  const q = "SELECT 1";
  const use = { id: "sevt_1", type: "agent.mcp_tool_use", name: "nsagent_suiteql", input: { query: q } };
  const result = (body: unknown) => ({ id: "sevt_2", type: "agent.mcp_tool_result", mcp_tool_use_id: "sevt_1", content: [{ type: "text", text: JSON.stringify(body) }] });
  it("takes rows only from a call whose query matches exactly", () => {
    expect(resultsFromEvents([use, result({ rows: [{ a: 1 }], hasMore: false })], [q]).results.get(q)?.rows).toEqual([{ a: 1 }]);
    const altered = { ...use, input: { query: "SELECT 1 " } };
    expect(resultsFromEvents([altered, result({ rows: [{ a: 9 }] })], [q]).results.size).toBe(0);
  });
  it("ignores the same query run through any other tool", () => {
    expect(resultsFromEvents([{ ...use, name: "ns_runCustomSuiteQL" }, result({ rows: [] })], [q]).results.size).toBe(0);
  });
  it("reports errors", () => {
    expect(resultsFromEvents([use, result({ error: "nope" })], [q]).errors.get(q)).toBe("nope");
  });
});

describe("transactions", () => {
  it("makes a comparison-period amount count against the change", () => {
    const rows = [{ account_id: 1, period_id: 1, txn_id: 5, tranid: null, type: "Journal", trandate: "2017-06-30", entity: null, memo: null, line_memo: "Rent", subsidiary: "US", lines: 2, usd: 100 }];
    const [t] = toTxns(rows, new Map([[1, "Expense"]]), 2);
    expect(t).toMatchObject({ amount: 100, contribution: -100, memo: "Rent" });
  });
});

describe("sign-off rules", () => {
  const now = "2026-11-01T00:00:00Z";
  it("will not sign off an insufficiently evidenced draft without a person's words", () => {
    expect(() => applyAction(wf({ draft: draftFixture }), { type: "prepare", accountId: 1, who: "a" }, "insufficient", now)).toThrow(/does not support/);
    expect(applyAction(wf({ draft: draftFixture, text: "Owner says lease renewal" }), { type: "prepare", accountId: 1, who: "a" }, "insufficient", now).state).toBe("prepared");
  });
  it("needs prepared before approved or sent back", () => {
    expect(() => applyAction(wf({ draft: draftFixture }), { type: "approve", accountId: 1, who: "b" }, "traced", now)).toThrow();
    expect(applyAction(wf({ state: "prepared" }), { type: "send_back", accountId: 1, who: "b", note: "Which lease?" }, null, now).state).toBe("sent_back");
  });
  it("locks an approved explanation until it is reopened, on the record", () => {
    const approved = wf({ state: "approved", text: "x" });
    expect(() => applyAction(approved, { type: "edit", accountId: 1, who: "a", text: "y" }, null, now)).toThrow(/approved/);
    const reopened = applyAction(approved, { type: "reopen", accountId: 1, who: "a", note: "Late entry" }, null, now);
    expect(reopened.state).toBe("open");
    expect(reopened.history.at(-1)).toMatchObject({ action: "reopened", who: "a", note: "Late entry" });
  });
  it("will not sign off a stale explanation", () => {
    expect(() => applyAction(wf({ text: "x", stale: true }), { type: "prepare", accountId: 1, who: "a" }, "traced", now)).toThrow(/ledger changed/);
  });
});

describe("refreshing the ledger", () => {
  const now = "2026-11-01T00:00:00Z";
  it("reopens a signed-off explanation when postings changed, and leaves it alone when they did not", () => {
    const before = { "1": wf({ state: "approved", text: "x", ledgerHash: "old" }), "2": wf({ state: "approved", text: "y", ledgerHash: "same" }) };
    const after = reconcileWorkflowEntries(before, new Map([[1, "new"], [2, "same"]]), [1, 2, 3], "sys", now);
    expect(after["1"]).toMatchObject({ state: "open", stale: true, ledgerHash: "new" });
    expect(after["1"]!.history.at(-1)!.action).toBe("ledger_changed");
    expect(after["2"]!.state).toBe("approved");
    expect(after["3"]!.state).toBe("open");
  });
});
