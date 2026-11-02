import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_POLICY,
  accountFlux,
  bridge,
  coverage,
  natural,
  rankDimension,
  residual,
  statement,
  tieOut,
  type AcctType,
  type ControlRow,
  type DimRow,
  type Policy,
  type Rates,
  type SubRow,
  type Txn,
} from "./engine";
import { draftExplanation, type Draft, type Evidence } from "./explain";
import { ACCOUNT_GROUPS, DIMENSIONS, DIMENSION_KEYS, accountSubsidiarySql, controlSql, dimensionSql, periodsSql, ratesSql, rootSubsidiarySql, transactionsSql, trendSql, type DimensionKey } from "./queries";
import { ReaderSession, type QueryResult } from "./reader";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(here, "../../data/flux");
const PACKS = path.join(DATA, "packs");
const META = path.join(DATA, "meta.json");
const POLICY = path.join(DATA, "policy.json");

/** Evidence is fetched for the largest flagged accounts first; the screen says when some were left out. */
const MAX_EVIDENCE_ACCOUNTS = 24;
/** The tool returns at most 200 rows, so batch size times values per account has to stay at or under that. */
const TOP_TRANSACTIONS = 25;
const TXN_ACCOUNTS_PER_BATCH = 4;
const TOP_DIM_VALUES = 8;
const DIM_ACCOUNTS_PER_BATCH = 12;
const TREND_PERIODS = 6;
const DRAFT_CONCURRENCY = 4;

export interface Period {
  id: number;
  name: string;
  firstDate: string;
  lines: number;
}

export interface Meta {
  periods: Period[];
  root: { id: number; name: string; currency: string } | null;
  refreshedAt: string | null;
  sessionId: string | null;
  status: "empty" | "loading" | "ready" | "failed";
  error?: string;
}

export interface HistoryEntry {
  at: string;
  who: string;
  action: "drafted" | "redrafted" | "edited" | "prepared" | "approved" | "sent_back" | "reopened" | "ledger_changed" | "threshold_changed" | "evidence_added";
  note?: string;
  ledgerHash: string;
}

export interface Workflow {
  state: "open" | "prepared" | "approved" | "sent_back";
  draft: Draft | null;
  /** The explanation as a person wrote or accepted it. Null until someone edits the draft. */
  text: string | null;
  guidance: string | null;
  draftError: string | null;
  stale: boolean;
  /** The ledger state this explanation was written against. */
  ledgerHash: string;
  priorExplanation: string | null;
  history: HistoryEntry[];
}

export interface Pack {
  id: string;
  cur: Period;
  prior: Period;
  root: { id: number; name: string; currency: string };
  status: "fetching" | "drafting" | "ready" | "failed";
  progress: string;
  error?: string;
  createdAt: string;
  refreshedAt: string;
  sessionIds: string[];
  policy: Policy;
  policyLog: { at: string; who: string; note: string }[];
  rows: SubRow[];
  control: ControlRow[];
  rates: Rates;
  trendPeriods: Period[];
  trend: Record<string, Record<string, number>>;
  dimensions: Partial<Record<DimensionKey, DimRow[]>>;
  transactions: Txn[];
  evidenceAccounts: number[];
  workflow: Record<string, Workflow>;
  /** Tokens spent drafting. These calls sit outside the reader session's spend cap, so they are counted here. */
  draftTokens?: { input: number; output: number };
}

const packFile = (id: string) => {
  if (!/^p\d+-c\d+$/.test(id)) throw new Error("Unknown flux pack.");
  return path.join(PACKS, `${id}.json`);
};

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value));
}
const savePack = (pack: Pack) => writeJson(packFile(pack.id), pack);

/** Jobs running in this process; a saved pack that says it is working but has no job was cut off by a restart. */
const running = new Set<string>();
let metaRunning = false;

// ---- Periods and the consolidation parent ----

export async function getMeta(): Promise<Meta> {
  const meta = await readJson<Meta>(META, { periods: [], root: null, refreshedAt: null, sessionId: null, status: "empty" });
  if (meta.status === "loading" && !metaRunning) return { ...meta, status: "failed", error: "The builder restarted while loading periods." };
  return meta;
}

export async function refreshMeta(): Promise<Meta> {
  if (metaRunning) return getMeta();
  metaRunning = true;
  const before = await getMeta();
  await writeJson(META, { ...before, status: "loading", error: undefined });
  void (async () => {
    try {
      const pSql = periodsSql();
      const rSql = rootSubsidiarySql();
      const { session, results } = await ReaderSession.start([pSql, rSql]);
      const roots = results.get(rSql)!.rows;
      if (roots.length !== 1) throw new Error(`Expected one top-level subsidiary, found ${roots.length}.`);
      const root = roots[0]!;
      const meta: Meta = {
        periods: results.get(pSql)!.rows.map((p) => ({ id: Number(p.id), name: String(p.name), firstDate: String(p.first_date), lines: Number(p.lines) })),
        root: { id: Number(root.id), name: String(root.name), currency: String(root.currency) },
        refreshedAt: new Date().toISOString(),
        sessionId: session.sessionId,
        status: "ready",
      };
      await writeJson(META, meta);
    } catch (error) {
      await writeJson(META, { ...before, status: "failed", error: String(error instanceof Error ? error.message : error) });
    } finally {
      metaRunning = false;
    }
  })();
  return getMeta();
}

// ---- Threshold policy: fixed before results are read, and every change after that is on the record ----

export const getPolicy = () => readJson<Policy>(POLICY, DEFAULT_POLICY);

export async function setDefaultPolicy(policy: Pick<Policy, "amount" | "percent" | "mode" | "alwaysAmount">): Promise<Policy> {
  const next = { ...(await getPolicy()), ...policy };
  await writeJson(POLICY, next);
  return next;
}

// ---- Preparing a pack ----

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const must = (results: Map<string, QueryResult>, sql: string): QueryResult => {
  const r = results.get(sql);
  if (!r) throw new Error("A query result went missing.");
  if (r.hasMore) throw new Error("NetSuite returned more rows than one query can carry, so this flux would be incomplete. Nothing was saved.");
  return r;
};

export const toSubRows = (rows: Record<string, unknown>[]): SubRow[] =>
  rows.map((r) => ({
    accountId: Number(r.account_id),
    account: String(r.account),
    type: String(r.accttype) as AcctType,
    subsidiaryId: Number(r.subsidiary_id),
    subsidiary: String(r.subsidiary ?? "Unknown"),
    localCur: num(r.local_cur),
    localPrior: num(r.local_prior),
    usdCur: num(r.usd_cur),
    usdPrior: num(r.usd_prior),
    lines: num(r.lines),
  }));

export function toTxns(rows: Record<string, unknown>[], types: Map<number, AcctType>, curId: number): Txn[] {
  return rows.map((r) => {
    const accountId = Number(r.account_id);
    const periodId = Number(r.period_id);
    const amount = natural(types.get(accountId) ?? "Expense", num(r.usd));
    return {
      accountId,
      periodId,
      id: Number(r.txn_id),
      tranid: r.tranid === null || r.tranid === undefined ? null : String(r.tranid),
      type: String(r.type),
      date: String(r.trandate),
      entity: r.entity === null || r.entity === undefined ? null : String(r.entity),
      memo: [r.memo, r.line_memo].filter((m) => m !== null && m !== undefined && m !== "").map(String)[0] ?? null,
      subsidiary: r.subsidiary === null || r.subsidiary === undefined ? null : String(r.subsidiary),
      lines: num(r.lines),
      amount,
      contribution: periodId === curId ? amount : -amount,
    };
  });
}

const chunks = <T>(list: T[], size: number): T[][] => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

export async function prepare(curId: number, priorId: number, who: string): Promise<string> {
  const meta = await getMeta();
  if (!meta.root) throw new Error("Load the periods first.");
  const cur = meta.periods.find((p) => p.id === curId);
  const prior = meta.periods.find((p) => p.id === priorId);
  if (!cur || !prior) throw new Error("Pick periods from the list.");
  if (curId === priorId) throw new Error("Pick two different periods.");
  const id = `p${curId}-c${priorId}`;
  if (running.has(id)) return id;
  running.add(id);
  const existing = await readJson<Pack | null>(packFile(id), null);
  const now = new Date().toISOString();
  const pack: Pack = existing
    ? { ...existing, status: "fetching", progress: "Reading the ledger", error: undefined }
    : {
        id,
        cur,
        prior,
        root: meta.root,
        status: "fetching",
        progress: "Reading the ledger",
        createdAt: now,
        refreshedAt: now,
        sessionIds: [],
        policy: await getPolicy(),
        policyLog: [],
        rows: [],
        control: [],
        rates: {},
        trendPeriods: [],
        trend: {},
        dimensions: {},
        transactions: [],
        evidenceAccounts: [],
        workflow: {},
      };
  await savePack(pack);
  void runPrepare(pack, meta, who)
    .catch(async (error) => {
      pack.status = "failed";
      pack.error = String(error instanceof Error ? error.message : error);
      await savePack(pack);
    })
    .finally(() => running.delete(id));
  return id;
}

async function runPrepare(pack: Pack, meta: Meta, who: string): Promise<void> {
  const { cur, prior, root } = pack;
  const ordered = meta.periods.slice().sort((a, b) => a.firstDate.localeCompare(b.firstDate));
  const curIndex = ordered.findIndex((p) => p.id === cur.id);
  const trendPeriods = [...new Map([...ordered.slice(Math.max(0, curIndex - (TREND_PERIODS - 1)), curIndex + 1), prior].map((p) => [p.id, p])).values()].sort((a, b) => a.firstDate.localeCompare(b.firstDate));

  const accountSqls = ACCOUNT_GROUPS.map((types) => accountSubsidiarySql(cur.id, prior.id, root.id, types));
  const cSql = controlSql(cur.id, prior.id, root.id);
  const rSql = ratesSql(cur.id, prior.id, root.id);
  const tSql = trendSql(trendPeriods.map((p) => p.id), root.id);
  const { session, results } = await ReaderSession.start([...accountSqls, cSql, rSql, tSql]);
  pack.sessionIds = [...pack.sessionIds, session.sessionId];

  const rows = accountSqls.flatMap((sql) => toSubRows(must(results, sql).rows));
  const control: ControlRow[] = must(results, cSql).rows.map((r) => ({ periodId: Number(r.period_id), type: String(r.accttype) as AcctType, usd: num(r.usd) }));
  const rates: Rates = Object.fromEntries(must(results, rSql).rows.map((r) => [String(r.subsidiary_id), { cur: r.rate_cur === null ? null : num(r.rate_cur), prior: r.rate_prior === null ? null : num(r.rate_prior) }]));
  const trend: Pack["trend"] = Object.fromEntries(
    must(results, tSql).rows.map((r) => [String(r.account_id), Object.fromEntries(trendPeriods.map((p) => [String(p.id), num(r[`p${p.id}`])]))]),
  );

  const accounts = accountFlux(rows, rates, pack.policy);
  const flagged = accounts.filter((a) => a.flagged).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const evidenceAccounts = flagged.slice(0, MAX_EVIDENCE_ACCOUNTS).map((a) => a.accountId);
  Object.assign(pack, { rows, control, rates, trend, trendPeriods, evidenceAccounts, refreshedAt: new Date().toISOString(), progress: `Reading evidence for ${evidenceAccounts.length} flagged accounts` });
  await savePack(pack);

  const txnSqls = chunks(evidenceAccounts, TXN_ACCOUNTS_PER_BATCH).map((b) => transactionsSql(cur.id, prior.id, root.id, b, TOP_TRANSACTIONS));
  const dimSqls = DIMENSION_KEYS.flatMap((dim) => chunks(evidenceAccounts, DIM_ACCOUNTS_PER_BATCH).map((b) => ({ dim, sql: dimensionSql(dim, cur.id, prior.id, root.id, b, TOP_DIM_VALUES) })));
  const evidence = await session.run([...txnSqls, ...dimSqls.map((d) => d.sql)]);
  const types = new Map(accounts.map((a) => [a.accountId, a.type]));
  pack.transactions = txnSqls.flatMap((sql) => toTxns(must(evidence, sql).rows, types, cur.id));
  pack.dimensions = {};
  for (const { dim, sql } of dimSqls) {
    const dimRows = must(evidence, sql).rows.map((r) => ({ accountId: Number(r.account_id), dim: r.dim === null || r.dim === undefined ? null : String(r.dim), usdCur: num(r.usd_cur), usdPrior: num(r.usd_prior) }));
    pack.dimensions[dim] = [...(pack.dimensions[dim] ?? []), ...dimRows];
  }

  await reconcileWorkflow(pack, who);
  pack.status = "drafting";
  await savePack(pack);
  await draftAll(pack, who);
  pack.status = "ready";
  pack.progress = "";
  await savePack(pack);
}

/** On a refresh, an explanation stays only while the ledger under it is unchanged; otherwise it is flagged and reopened. */
export function reconcileWorkflowEntries(workflow: Record<string, Workflow>, hashes: Map<number, string>, flaggedIds: number[], who: string, now: string): Record<string, Workflow> {
  const next = { ...workflow };
  for (const id of flaggedIds) {
    const key = String(id);
    const hash = hashes.get(id) ?? "";
    const w = next[key];
    if (!w) {
      next[key] = { state: "open", draft: null, text: null, guidance: null, draftError: null, stale: false, ledgerHash: hash, priorExplanation: null, history: [] };
    } else if (w.ledgerHash !== hash) {
      next[key] = { ...w, state: "open", stale: true, ledgerHash: hash, history: [...w.history, { at: now, who, action: "ledger_changed", note: "Postings changed after this explanation was written; sign-offs were reopened.", ledgerHash: hash }] };
    }
  }
  return next;
}

async function reconcileWorkflow(pack: Pack, who: string): Promise<void> {
  const accounts = accountFlux(pack.rows, pack.rates, pack.policy);
  const hashes = new Map(accounts.map((a) => [a.accountId, a.ledgerHash]));
  pack.workflow = reconcileWorkflowEntries(pack.workflow, hashes, pack.evidenceAccounts, who, new Date().toISOString());
  // Carry forward: last period's approved words, shown beside this month's evidence, never accepted without it.
  const previous = await readJson<Pack | null>(await findPackForCurrent(pack.prior.id), null);
  if (previous) {
    for (const id of pack.evidenceAccounts) {
      const before = previous.workflow[String(id)];
      if (before?.state === "approved") pack.workflow[String(id)]!.priorExplanation = before.text ?? before.draft?.summary ?? null;
    }
  }
}

async function findPackForCurrent(periodId: number): Promise<string> {
  const names = await readdir(PACKS).catch(() => [] as string[]);
  const match = names.find((n) => n.startsWith(`p${periodId}-c`));
  return match ? path.join(PACKS, match) : path.join(PACKS, "none.json");
}

function evidenceFor(pack: Pack, accountId: number, guidance?: string): Evidence {
  const accounts = accountFlux(pack.rows, pack.rates, pack.policy);
  const account = accounts.find((a) => a.accountId === accountId);
  if (!account) throw new Error("Unknown account.");
  return {
    account,
    curName: pack.cur.name,
    priorName: pack.prior.name,
    trend: pack.trendPeriods.map((p) => ({ period: p.name, amount: natural(account.type, pack.trend[String(accountId)]?.[String(p.id)] ?? 0) })),
    dimensions: Object.fromEntries(DIMENSION_KEYS.map((k) => [DIMENSIONS[k].label, rankDimension(account, pack.dimensions[k] ?? []).values])),
    transactions: pack.transactions.filter((t) => t.accountId === accountId),
    priorExplanation: pack.workflow[String(accountId)]?.priorExplanation ?? null,
    ...(guidance ? { guidance } : {}),
  };
}

async function draftOne(pack: Pack, accountId: number, who: string, guidance?: string): Promise<void> {
  const key = String(accountId);
  const w = pack.workflow[key]!;
  try {
    const { draft, usage } = await draftExplanation(evidenceFor(pack, accountId, guidance));
    pack.draftTokens = { input: (pack.draftTokens?.input ?? 0) + usage.input, output: (pack.draftTokens?.output ?? 0) + usage.output };
    const action = w.draft ? "redrafted" : "drafted";
    // The model wrote this, not the person who asked; the record has to say so.
    pack.workflow[key] = { ...w, draft, draftError: null, stale: false, guidance: guidance ?? w.guidance, history: [...w.history, { at: new Date().toISOString(), who: `Claude, asked by ${who}`, action, ...(guidance ? { note: guidance } : {}), ledgerHash: w.ledgerHash }] };
  } catch (error) {
    pack.workflow[key] = { ...w, draftError: String(error instanceof Error ? error.message : error) };
  }
}

async function draftAll(pack: Pack, who: string): Promise<void> {
  const todo = pack.evidenceAccounts.filter((id) => {
    const w = pack.workflow[String(id)];
    return w && (!w.draft || w.stale);
  });
  let done = 0;
  for (const batch of chunks(todo, DRAFT_CONCURRENCY)) {
    pack.progress = `Drafting explanations: ${done} of ${todo.length}`;
    await savePack(pack);
    await Promise.all(batch.map((id) => draftOne(pack, id, who)));
    done += batch.length;
  }
}

// ---- Reading a pack ----

export async function listPacks() {
  const names = await readdir(PACKS).catch(() => [] as string[]);
  const packs = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => readJson<Pack | null>(path.join(PACKS, n), null)));
  return packs
    .filter((p): p is Pack => Boolean(p))
    .map((p) => {
      const states = Object.values(p.workflow);
      return { id: p.id, cur: p.cur.name, prior: p.prior.name, status: p.status, refreshedAt: p.refreshedAt, flagged: p.evidenceAccounts.length, approved: states.filter((w) => w.state === "approved").length };
    })
    .sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
}

async function loadPack(id: string): Promise<Pack> {
  const pack = await readJson<Pack | null>(packFile(id), null);
  if (!pack) throw new Error("Unknown flux pack.");
  if ((pack.status === "fetching" || pack.status === "drafting") && !running.has(id)) return { ...pack, status: "failed", error: "The builder restarted while this was being prepared. Prepare it again; work already saved stays." };
  return pack;
}

const netsuiteUrl = (txnId: number) => `https://tstdrv1755417.app.netsuite.com/app/accounting/transactions/transaction.nl?id=${txnId}`;

/** Everything the screen needs, computed fresh from the stored rows so that a threshold change re-flags without another read. */
export async function packView(id: string) {
  const pack = await loadPack(id);
  const accounts = accountFlux(pack.rows, pack.rates, pack.policy);
  const stmt = statement(accounts);
  const netChange = stmt.netIncome.delta;
  const view = accounts.map((a) => {
    const w = pack.workflow[String(a.accountId)] ?? null;
    const txns = pack.transactions.filter((t) => t.accountId === a.accountId).sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
    const cov = w?.draft ? coverage(a.delta, w.draft.drivers, txns) : null;
    return {
      ...a,
      shareOfNetChange: netChange !== 0 ? a.impact / netChange : null,
      netIfFlat: netChange - a.impact,
      hasEvidence: pack.evidenceAccounts.includes(a.accountId),
      trend: pack.trendPeriods.map((p) => ({ period: p.name, amount: natural(a.type, pack.trend[String(a.accountId)]?.[String(p.id)] ?? 0) })),
      dimensions: Object.fromEntries(DIMENSION_KEYS.map((k) => [k, { label: DIMENSIONS[k].label, ...rankDimension(a, pack.dimensions[k] ?? []) }])),
      transactions: txns.map((t) => ({ ...t, url: netsuiteUrl(t.id), inCurrent: t.periodId === pack.cur.id })),
      workflow: w,
      coverage: cov,
    };
  });
  const flagged = view.filter((a) => a.flagged);
  const sum = (f: (a: (typeof view)[number]) => number) => accounts.length ? view.reduce((t, a) => t + f(a), 0) : 0;
  return {
    id: pack.id,
    status: pack.status,
    progress: pack.progress,
    error: pack.error,
    refreshedAt: pack.refreshedAt,
    createdAt: pack.createdAt,
    sessionIds: pack.sessionIds,
    draftTokens: pack.draftTokens ?? null,
    cur: pack.cur,
    prior: pack.prior,
    root: pack.root,
    policy: pack.policy,
    policyLog: pack.policyLog,
    statement: stmt,
    bridge: bridge(accounts),
    residual: residual(accounts),
    tie: tieOut(accounts, pack.control, pack.cur.id, pack.prior.id),
    totals: { activity: sum((a) => a.impact === 0 ? 0 : (a.impact / (a.delta || 1)) * a.activity), fx: sum((a) => a.impact === 0 ? 0 : (a.impact / (a.delta || 1)) * a.fx) },
    ratesMoved: Object.values(pack.rates).some((r) => r.cur !== null && r.prior !== null && r.cur !== r.prior),
    counts: {
      accounts: view.length,
      flagged: flagged.length,
      withEvidence: flagged.filter((a) => a.hasEvidence).length,
      prepared: flagged.filter((a) => a.workflow?.state === "prepared").length,
      approved: flagged.filter((a) => a.workflow?.state === "approved").length,
      sentBack: flagged.filter((a) => a.workflow?.state === "sent_back").length,
      stale: flagged.filter((a) => a.workflow?.stale).length,
    },
    accounts: view,
  };
}

// ---- Preparer and reviewer actions ----

export type Action =
  | { type: "edit"; accountId: number; who: string; text: string }
  | { type: "prepare"; accountId: number; who: string; note?: string }
  | { type: "approve"; accountId: number; who: string; note?: string }
  | { type: "send_back"; accountId: number; who: string; note: string }
  | { type: "reopen"; accountId: number; who: string; note: string };

/** The sign-off rules, separate from storage so they can be tested. Throws when a step is not allowed. */
export function applyAction(w: Workflow, action: Action, tracedState: string | null, now: string): Workflow {
  const entry = (a: HistoryEntry["action"], note?: string): HistoryEntry => ({ at: now, who: action.who, action: a, ...(note ? { note } : {}), ledgerHash: w.ledgerHash });
  switch (action.type) {
    case "edit":
      if (w.state === "approved") throw new Error("This explanation is approved. Reopen it to change it.");
      return { ...w, text: action.text, stale: false, history: [...w.history, entry("edited")] };
    case "prepare":
      if (w.state === "approved") throw new Error("This explanation is already approved.");
      if (w.stale) throw new Error("The ledger changed after this explanation was written. Re-read it and save or redraft it first.");
      if (!w.text && !w.draft) throw new Error("There is no explanation to sign off yet.");
      if (!w.text && tracedState === "insufficient") throw new Error("The evidence does not support this draft. Write what the account owner told you before signing off.");
      return { ...w, state: "prepared", text: w.text ?? w.draft!.summary, history: [...w.history, entry("prepared", action.note)] };
    case "approve":
      if (w.state !== "prepared") throw new Error("Only a prepared explanation can be approved.");
      return { ...w, state: "approved", history: [...w.history, entry("approved", action.note)] };
    case "send_back":
      if (w.state !== "prepared") throw new Error("Only a prepared explanation can be sent back.");
      return { ...w, state: "sent_back", history: [...w.history, entry("sent_back", action.note)] };
    case "reopen":
      if (w.state !== "approved") throw new Error("Only an approved explanation can be reopened.");
      return { ...w, state: "open", history: [...w.history, entry("reopened", action.note)] };
  }
}

export async function act(id: string, action: Action) {
  const pack = await loadPack(id);
  const key = String(action.accountId);
  const w = pack.workflow[key];
  if (!w) throw new Error("This account has no evidence yet. Prepare the flux again to fetch it.");
  const account = accountFlux(pack.rows, pack.rates, pack.policy).find((a) => a.accountId === action.accountId);
  const txns = pack.transactions.filter((t) => t.accountId === action.accountId);
  const cov = account && w.draft ? coverage(account.delta, w.draft.drivers, txns) : null;
  pack.workflow[key] = applyAction(w, action, cov?.state ?? null, new Date().toISOString());
  await savePack(pack);
  return packView(id);
}

export async function redraft(id: string, accountId: number, who: string, guidance: string) {
  const pack = await loadPack(id);
  const w = pack.workflow[String(accountId)];
  if (!w) throw new Error("This account has no evidence yet. Prepare the flux again to fetch it.");
  if (w.state === "approved") throw new Error("This explanation is approved. Reopen it to change it.");
  await draftOne(pack, accountId, who, guidance);
  await savePack(pack);
  return packView(id);
}

/** Changes a threshold on a pack and records that it happened after results were visible: the audit question. */
export async function changePolicy(id: string, who: string, change: { amount?: number; percent?: number; alwaysAmount?: number; mode?: Policy["mode"]; accountId?: number; clearOverride?: boolean }, reason: string) {
  const pack = await loadPack(id);
  if (!reason.trim()) throw new Error("Say why the threshold is changing; the reason goes in the evidence packet.");
  const summary = (p: Policy) => JSON.stringify({ amount: p.amount, percent: p.percent, mode: p.mode, alwaysAmount: p.alwaysAmount });
  const before = summary(pack.policy);
  if (change.accountId !== undefined) {
    const key = String(change.accountId);
    const overrides = { ...pack.policy.overrides };
    if (change.clearOverride) delete overrides[key];
    else overrides[key] = { ...(change.amount !== undefined ? { amount: change.amount } : {}), ...(change.percent !== undefined ? { percent: change.percent } : {}) };
    pack.policy = { ...pack.policy, overrides };
    pack.policyLog.push({ at: new Date().toISOString(), who, note: `Account ${change.accountId} ${change.clearOverride ? "override removed" : `override ${JSON.stringify(overrides[key])}`}: ${reason}` });
  } else {
    pack.policy = { ...pack.policy, ...(change.amount !== undefined ? { amount: change.amount } : {}), ...(change.percent !== undefined ? { percent: change.percent } : {}), ...(change.alwaysAmount !== undefined ? { alwaysAmount: change.alwaysAmount } : {}), ...(change.mode ? { mode: change.mode } : {}) };
    pack.policyLog.push({ at: new Date().toISOString(), who, note: `From ${before} to ${summary(pack.policy)}: ${reason}` });
  }
  await savePack(pack);
  return packView(id);
}

// ---- Evidence packet ----

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csvRow = (cells: unknown[]) => cells.map(csvCell).join(",");
const money = (n: number) => n.toFixed(2);

/** One CSV a controller can file: basis, tie-out, each flagged account with priced drivers, citations and sign-off trail. */
export async function evidencePacket(id: string): Promise<{ filename: string; csv: string }> {
  const v = await packView(id);
  const out: string[] = [];
  out.push(csvRow(["Flux evidence packet"]));
  out.push(csvRow(["Periods", `${v.cur.name} vs ${v.prior.name}`]));
  out.push(csvRow(["Basis", `Consolidated to ${v.root.name} in ${v.root.currency}, posting period, NetSuite consolidated average rates`]));
  out.push(csvRow(["Ledger read", v.refreshedAt]));
  out.push(csvRow(["Reader sessions", v.sessionIds.join(" ")]));
  out.push(csvRow(["Tie-out to ledger total", v.tie.ties ? "Ties" : `Difference ${money(v.tie.difference)}`]));
  out.push(csvRow(["Threshold", `${v.policy.mode}: amount ${v.policy.amount}, percent ${v.policy.percent}, always over ${v.policy.alwaysAmount ?? "none"}`, JSON.stringify(v.policy.overrides)]));
  for (const p of v.policyLog) out.push(csvRow(["Threshold change", p.at, p.who, p.note]));
  out.push(csvRow(["Below threshold", `${v.residual.count} accounts`, `net ${money(v.residual.net)}`, `up ${money(v.residual.grossUp)}`, `down ${money(v.residual.grossDown)}`]));
  out.push("");
  out.push(csvRow(["Account", v.cur.name, v.prior.name, "Change", "Activity", "FX", "Flag", "State", "Stale", "Traced %", "Remainder", "Explanation", "Owner question", "Prepared by", "Approved by", "Same person"]));
  for (const a of v.accounts.filter((x) => x.flagged)) {
    const w = a.workflow;
    const preparedBy = w?.history.filter((h) => h.action === "prepared").at(-1)?.who ?? "";
    const approvedBy = w?.history.filter((h) => h.action === "approved").at(-1)?.who ?? "";
    out.push(csvRow([a.account, money(a.cur), money(a.prior), money(a.delta), money(a.activity), money(a.fx), a.flagReason, w?.state ?? "no evidence", w?.stale ? "yes" : "", a.coverage ? Math.round(a.coverage.tracedPct * 100) : "", a.coverage ? money(a.coverage.remainder) : "", w?.text ?? w?.draft?.summary ?? "", w?.draft?.questionForOwner ?? "", preparedBy, approvedBy, preparedBy && preparedBy === approvedBy ? "yes" : ""]));
  }
  out.push("");
  out.push(csvRow(["Account", "Driver", "Amount", "Cause status", "Cause", "Cited transactions"]));
  for (const a of v.accounts) for (const d of a.coverage?.drivers ?? []) out.push(csvRow([a.account, d.label, money(d.amount), d.causeStatus, d.cause, d.transactionIds.join(" ")]));
  out.push("");
  out.push(csvRow(["Account", "When", "Who", "Action", "Note", "Ledger state"]));
  for (const a of v.accounts) for (const h of a.workflow?.history ?? []) out.push(csvRow([a.account, h.at, h.who, h.action, h.note ?? "", h.ledgerHash]));
  return { filename: `flux-evidence-${v.cur.name.replace(/\s+/g, "-")}-vs-${v.prior.name.replace(/\s+/g, "-")}.csv`, csv: `${out.join("\n")}\n` };
}
