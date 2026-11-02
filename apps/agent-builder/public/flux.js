// Flux analysis screen. Every figure comes from the server's arithmetic; nothing here computes a variance.
const FLUX_WHO = "flux-signing-as";
const flux = { pack: null, filter: "needs", open: null, tab: "explain", dim: "subsidiary", notice: "" };

const fluxWho = () => {
  try { return localStorage.getItem(FLUX_WHO) || "dja0086"; } catch { return "dja0086"; }
};
const setFluxWho = (v) => { try { localStorage.setItem(FLUX_WHO, v); } catch {} };

const usd = (n) => `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
const signedUsd = (n) => (Math.round(n) === 0 ? "$0" : `${n > 0 ? "+" : "−"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`);
const pctText = (p) => (p === null || p === undefined ? "n.a." : `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p * 100).toFixed(Math.abs(p) >= 10 ? 0 : 1)}%`);
const shareText = (s) => (s === null || s === undefined ? "n.a." : `${(s * 100).toFixed(Math.abs(s) >= 10 ? 0 : 1).replace("-", "−")}%`);
const impactClass = (impact) => (Math.round(impact) === 0 ? "neutral" : impact > 0 ? "fav" : "unfav");
const impactWord = (impact) => (Math.round(impact) === 0 ? "No effect on profit" : impact > 0 ? "Favourable" : "Unfavourable");
const TXN_NAME = { CustInvc: "Invoice", CustCred: "Credit memo", CustPymt: "Client payment", VendBill: "Vendor invoice", VendPymt: "Vendor payment", VendCred: "Vendor credit", Journal: "Journal", ExpRept: "Expense report", SalesOrd: "Master Contract", Check: "Check", Deposit: "Deposit" };
const txnName = (type) => TXN_NAME[type] ?? type;
const txnRef = (t) => `${txnName(t.type)} ${t.tranid ?? `#${t.id}`}`;

// ---------- Start page: pick periods ----------
async function fluxHome() {
  const seq = routeSeq;
  setNav("flux");
  setCrumbs([{ label: "Flux" }]);
  const { meta, policy, packs } = await api("GET", "/api/flux");
  if (stale(seq)) return;
  const periods = meta.periods;
  const options = (selected) => periods.map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)} · ${p.lines.toLocaleString("en-US")} lines</option>`).join("");
  const loading = meta.status === "loading";
  $("view").innerHTML = `
    <div class="card">
      <div class="title" style="margin-top:0">Prepare a flux</div>
      <p class="reason" style="margin:4px 0 16px">Reads the ledger, flags what moved past your thresholds, and drafts each explanation from the transactions behind it. Every number is computed from NetSuite; you decide what it means.</p>
      ${periods.length ? `
        <div class="fx-form">
          <label>Period<select id="fx-cur">${options(periods[fluxBusiest(periods)]?.id)}</select></label>
          <label>Compared to<select id="fx-prior">${options(periods[fluxBusiest(periods) + 1]?.id)}</select></label>
          <button class="btn primary" id="fx-prepare">Prepare flux</button>
        </div>
        <div class="fx-quick"><button id="fx-prev">Prior period</button><button id="fx-yoy">Same period last year</button></div>
      ` : `<p class="empty">${loading ? "Loading the periods from NetSuite. This takes about a minute." : "First, load the accounting periods from NetSuite."}</p>${loading ? "" : `<button class="btn primary" id="fx-load">Load periods</button>`}`}
      <div id="fx-err">${meta.error ? `<span class="error">${esc(meta.error)}</span>` : ""}</div>
    </div>
    <div class="card">
      <div class="title" style="margin-top:0">Threshold policy</div>
      <p class="reason" style="margin:4px 0 16px">Set this before you read results. New flux packs start from it. A change made to a pack afterwards needs a reason, and that reason goes in the evidence packet.</p>
      <div class="fx-form">
        <label>Amount (${esc(meta.root?.currency ?? "USD")})<input type="text" inputmode="numeric" id="fx-amount" value="${policy.amount}"></label>
        <label>Percent<input type="text" inputmode="decimal" id="fx-percent" value="${policy.percent * 100}"></label>
        <label>Flag when<select id="fx-mode"><option value="either" ${policy.mode === "either" ? "selected" : ""}>Either is passed</option><option value="both" ${policy.mode === "both" ? "selected" : ""}>Both are passed</option></select></label>
        <label>Always flag over<input type="text" inputmode="numeric" id="fx-always" value="${policy.alwaysAmount ?? ""}"></label>
        <button class="btn" id="fx-save-policy">Save</button>
      </div>
      <div id="fx-policy-note" class="quiet"></div>
    </div>
    ${packs.length ? `<div class="card"><div class="title" style="margin-top:0">Prepared</div>${packs.map((p) => `
      <a class="fx-pack" href="#/flux/${esc(p.id)}"><span><b>${esc(p.cur)}</b> vs ${esc(p.prior)}</span><span class="quiet">${p.status === "ready" ? `${p.approved} of ${p.flagged} approved` : esc(p.status)} · read ${esc(when(p.refreshedAt))}</span></a>`).join("")}</div>` : ""}`;

  if ($("fx-load")) $("fx-load").onclick = () => busy($("fx-load"), $("fx-err"), async () => { await api("POST", "/api/flux/periods"); route(); });
  if (loading) pollTimer = setTimeout(() => { if (!stale(seq)) route(); }, 5000);
  $("fx-save-policy").onclick = () => busy($("fx-save-policy"), $("fx-policy-note"), async () => {
    const amount = Number($("fx-amount").value.replace(/[,$\s]/g, ""));
    const percent = Number($("fx-percent").value.replace(/[%\s]/g, "")) / 100;
    if (!Number.isFinite(amount) || !Number.isFinite(percent)) throw new Error("Enter numbers for the amount and percent.");
    const alwaysAmount = Number($("fx-always").value.replace(/[,$\s]/g, ""));
    if (!Number.isFinite(alwaysAmount)) throw new Error("Enter a number for the always-flag amount.");
    await api("POST", "/api/flux/policy", { amount, percent, alwaysAmount, mode: $("fx-mode").value });
    $("fx-policy-note").textContent = "Saved. Applies to flux packs prepared from now on.";
  });
  if (!periods.length) return;
  const ordered = periods.slice().sort((a, b) => a.firstDate.localeCompare(b.firstDate));
  const pickPrior = (pick) => {
    const cur = ordered.find((p) => p.id === Number($("fx-cur").value));
    const found = pick(cur);
    if (found) $("fx-prior").value = String(found.id);
    else $("fx-err").innerHTML = `<span class="error">NetSuite shows no postings for that comparison period.</span>`;
  };
  $("fx-prev").onclick = () => pickPrior((cur) => ordered[ordered.indexOf(cur) - 1]);
  $("fx-yoy").onclick = () => pickPrior((cur) => {
    const [mon, year] = cur.name.split(" ");
    return ordered.find((p) => p.name === `${mon} ${Number(year) - 1}`);
  });
  $("fx-prepare").onclick = () => busy($("fx-prepare"), $("fx-err"), async () => {
    const { id } = await api("POST", "/api/flux/prepare", { cur: Number($("fx-cur").value), prior: Number($("fx-prior").value), who: fluxWho() });
    location.hash = `#/flux/${id}`;
  });
}
/** The newest period with real activity, so a demo account with a sparse recent ledger opens on something useful. */
function fluxBusiest(periods) {
  const max = Math.max(...periods.map((p) => p.lines));
  const i = periods.findIndex((p) => p.lines >= Math.max(50, max * 0.05));
  return i >= 0 ? Math.min(i, periods.length - 2) : 0;
}

// ---------- A prepared flux ----------
async function fluxPack(id) {
  const seq = routeSeq;
  setNav("flux");
  const pack = await api("GET", `/api/flux/packs/${id}`);
  if (stale(seq)) return;
  flux.pack = pack;
  setCrumbs([{ label: "Flux", href: "#/flux" }, { label: `${pack.cur.name} vs ${pack.prior.name}` }]);
  renderPack();
  if (pack.status === "fetching" || pack.status === "drafting") pollTimer = setTimeout(() => { if (!stale(seq)) fluxPack(id); }, 4000);
}

function renderPack() {
  const p = flux.pack;
  const v = $("view");
  const scroll = document.querySelector(".fx-drawer")?.scrollTop ?? 0;
  if (!p.accounts.length) {
    v.innerHTML = `<div class="card">${p.status === "failed" ? `<span class="error">${esc(p.error)}</span><p><a href="#/flux">Back to Flux</a></p>` : `<div class="title" style="margin-top:0">${esc(p.progress || "Working")}</div><p class="reason">Reading ${esc(p.cur.name)} and ${esc(p.prior.name)} from NetSuite. Usually a few minutes; you can leave this page.</p>${p.sessionIds[0] ? `<a href="#/run/${esc(p.sessionIds[0])}" class="quiet">Watch the reader</a>` : ""}`}</div>`;
    return;
  }
  const ni = p.statement.netIncome;
  v.innerHTML = `
    ${p.status === "failed" ? `<div class="card error">${esc(p.error)}</div>` : ""}
    ${p.status === "fetching" || p.status === "drafting" ? `<div class="card fx-progress"><span>${esc(p.progress)}</span><span class="quiet">Figures below are final; explanations are still arriving.</span></div>` : ""}
    <div class="fx-head">
      <div>
        <div class="fx-headline">Net income ${signedUsd(ni.delta)} <span class="quiet-big">to ${usd(ni.cur)}, ${pctText(ni.pct)} vs ${esc(p.prior.name)}</span></div>
        <div class="fx-progressline">${fluxProgressLine(p)}</div>
      </div>
      <div class="fx-actions">
        <button class="btn" id="fx-reread">Re-read ledger</button>
        <button class="btn" id="fx-export">Evidence packet</button>
      </div>
    </div>
    <div class="fx-chips">
      <span class="fx-chip">Consolidated to ${esc(p.root.name)}</span>
      <span class="fx-chip">${esc(p.root.currency)}</span>
      <span class="fx-chip">Posting period</span>
      <span class="fx-chip">NetSuite average rates</span>
      <span class="fx-chip ${p.tie.ties ? "" : "bad"}">${p.tie.ties ? "Ties to the ledger total" : `Off from the ledger total by ${esc(usd(p.tie.difference))}`}</span>
      <span class="fx-chip">Read ${esc(when(p.refreshedAt))}</span>
      <span class="fx-chip">${fluxPolicyText(p.policy)}${p.policyLog.length ? ` · changed ${p.policyLog.length}×` : ""}</span>
      <label class="fx-who">Signing as <input type="text" id="fx-who" value="${esc(fluxWho())}"></label>
    </div>
    <div id="fx-page-note">${flux.notice ? `<div class="quiet">${esc(flux.notice)}</div>` : ""}</div>
    ${fluxFxNote(p)}
    <div class="card fx-card">${fluxBridge(p)}</div>
    <div class="card fx-card fx-table-card">${fluxTable(p)}</div>
    <details class="fx-policy"><summary>Change this flux's threshold</summary>
      <p class="quiet">Changing it after seeing results is recorded with your reason, and it shows in the evidence packet.</p>
      <div class="fx-form">
        <label>Amount<input type="text" id="fx-p-amount" value="${p.policy.amount}"></label>
        <label>Percent<input type="text" id="fx-p-percent" value="${p.policy.percent * 100}"></label>
        <label>Flag when<select id="fx-p-mode"><option value="either" ${p.policy.mode === "either" ? "selected" : ""}>Either is passed</option><option value="both" ${p.policy.mode === "both" ? "selected" : ""}>Both are passed</option></select></label>
        <label>Always flag over<input type="text" id="fx-p-always" value="${p.policy.alwaysAmount ?? ""}"></label>
        <label class="fx-grow">Reason<input type="text" id="fx-p-reason"></label>
        <button class="btn" id="fx-p-save">Change</button>
      </div>
      <div id="fx-p-err"></div>
      ${p.policyLog.map((l) => `<div class="quiet">${esc(when(l.at))} · ${esc(l.who)} · ${esc(l.note)}</div>`).join("")}
    </details>
    ${flux.open !== null ? fluxDrawer(p) : ""}`;
  wirePack();
  const drawer = document.querySelector(".fx-drawer");
  if (drawer) drawer.scrollTop = scroll;
}

const fluxPolicyText = (policy) => `Flags over ${usd(policy.amount)} ${policy.mode === "both" ? "and" : "or"} ${(policy.percent * 100).toFixed(0)}%${policy.alwaysAmount ? `, or any over ${usd(policy.alwaysAmount)}` : ""}`;

function fluxProgressLine(p) {
  const c = p.counts;
  const parts = [`<b>${c.flagged}</b> of ${c.accounts} accounts need an explanation`, `${c.prepared} prepared`, `${c.approved} approved`];
  if (c.sentBack) parts.push(`${c.sentBack} sent back`);
  if (c.stale) parts.push(`<span class="bad-text">${c.stale} out of date</span>`);
  if (c.withEvidence < c.flagged) parts.push(`evidence read for the largest ${c.withEvidence}`);
  return parts.join(" · ");
}

function fluxFxNote(p) {
  const fx = p.totals.fx;
  if (!p.ratesMoved) return `<div class="quiet fx-note">Currency effect: $0. NetSuite's consolidated rates are identical in both periods, so all of this change is activity.</div>`;
  return `<div class="quiet fx-note">Of the ${signedUsd(p.statement.netIncome.delta)}: activity at ${esc(p.prior.name)} rates ${signedUsd(p.totals.activity)}, currency effect ${signedUsd(fx)}.</div>`;
}

// ---------- Bridge ----------
function fluxBridge(p) {
  const b = p.bridge;
  let running = b.start;
  const walk = b.steps.map((s) => {
    const from = running;
    running += s.impact;
    return { ...s, from, to: running };
  });
  const lo = Math.min(0, b.start, b.end, ...walk.map((s) => Math.min(s.from, s.to)));
  const hi = Math.max(0, b.start, b.end, ...walk.map((s) => Math.max(s.from, s.to)));
  const x = (n) => ((n - lo) / (hi - lo || 1)) * 100;
  const bar = (a, c, cls) => `<span class="fx-wbar ${cls}" style="left:${Math.min(x(a), x(c)).toFixed(2)}%;width:${Math.max(Math.abs(x(c) - x(a)), 0.4).toFixed(2)}%"></span>`;
  const row = (label, value, track, opts = {}) => `<${opts.id !== undefined ? `button type="button" data-open="${opts.id}"` : "div"} class="fx-wrow ${opts.total ? "total" : ""}" title="${esc(label)}: ${esc(value)}${opts.word ? `, ${opts.word.toLowerCase()}` : ""}"><span class="fx-wlabel">${esc(label)}</span><span class="fx-wtrack">${track}</span><span class="fx-wvalue">${esc(value)}</span></${opts.id !== undefined ? "button" : "div"}>`;
  return `
    <div class="fx-section-title">How net income got from ${esc(p.prior.name)} to ${esc(p.cur.name)}</div>
    <div class="fx-legend"><span><i class="swatch fav"></i>Raises profit</span><span><i class="swatch unfav"></i>Lowers profit</span></div>
    <div class="fx-waterfall">
      ${row(p.prior.name, usd(b.start), bar(0, b.start, "base"), { total: true })}
      ${walk.map((s) => row(s.kind === "account" ? s.label : `${s.label} (${s.count} accounts)`, signedUsd(s.impact), bar(s.from, s.to, impactClass(s.impact)), { id: s.accountId ?? undefined, word: impactWord(s.impact) })).join("")}
      ${row(p.cur.name, usd(b.end), bar(0, b.end, "base"), { total: true })}
    </div>`;
}

// ---------- Table ----------
const fluxState = (a) => {
  if (!a.flagged) return { key: "below", label: "Below threshold" };
  const w = a.workflow;
  if (!w) return { key: "noev", label: "No evidence read" };
  if (w.stale) return { key: "stale", label: "Out of date" };
  return { open: { key: "open", label: "To explain" }, prepared: { key: "prepared", label: "Prepared" }, approved: { key: "approved", label: "Approved" }, sent_back: { key: "sent", label: "Sent back" } }[w.state];
};
const RISK_ORDER = { sent: 0, stale: 1, open: 2, noev: 3, prepared: 4, approved: 5, below: 6 };

function fluxTable(p) {
  const maxDelta = Math.max(1, ...p.accounts.map((a) => Math.abs(a.delta)));
  const row = (a) => {
    const st = fluxState(a);
    const width = (Math.abs(a.delta) / maxDelta) * 50;
    const cls = impactClass(a.impact);
    return `<tr data-open="${a.accountId}" tabindex="0" class="${flux.open === a.accountId ? "selected" : ""}">
      <td class="fx-acct">${esc(a.account)}</td>
      <td class="num">${usd(a.cur)}</td>
      <td class="num muted">${usd(a.prior)}</td>
      <td class="fx-delta"><span class="fx-dbar"><span class="fx-dfill ${cls}" style="${a.delta >= 0 ? "left:50%" : `right:50%`};width:${width.toFixed(2)}%"></span></span><span class="num" title="${impactWord(a.impact)}">${signedUsd(a.delta)}</span></td>
      <td class="num">${pctText(a.pct)}</td>
      <td class="num muted">${shareText(a.shareOfNetChange)}</td>
      <td class="fx-ev">${a.coverage ? `<span class="fx-meter" title="${Math.round(a.coverage.tracedPct * 100)}% of the change traced to cited transactions"><i class="${a.coverage.state}" style="width:${Math.round(a.coverage.tracedPct * 100)}%"></i></span><span class="quiet">${Math.round(a.coverage.tracedPct * 100)}%</span>` : `<span class="quiet">${a.flagged ? "—" : ""}</span>`}</td>
      <td><span class="fx-state ${st.key}">${esc(st.label)}</span></td>
    </tr>`;
  };
  const sub = (label, l) => `<tr class="fx-sub"><td>${esc(label)}</td><td class="num">${usd(l.cur)}</td><td class="num muted">${usd(l.prior)}</td><td class="fx-delta"><span class="fx-dbar"></span><span class="num">${signedUsd(l.delta)}</span></td><td class="num">${pctText(l.pct)}</td><td></td><td></td><td></td></tr>`;
  const head = `<thead><tr><th>Account</th><th class="num">${esc(p.cur.name)}</th><th class="num">${esc(p.prior.name)}</th><th class="num">Change vs ${esc(p.prior.name)}</th><th class="num">%</th><th class="num" title="This account's share of the change in net income. Can pass 100% when others move the opposite way.">Of net change</th><th>Traced</th><th>State</th></tr></thead>`;
  const needs = p.accounts.filter((a) => a.flagged).sort((a, b) => RISK_ORDER[fluxState(a).key] - RISK_ORDER[fluxState(b).key] || Math.abs(b.impact) - Math.abs(a.impact));
  const review = p.accounts.filter((a) => a.workflow?.state === "prepared" && a.flagged).sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact));
  const r = p.residual;
  const residualRow = `<tr class="fx-residual"><td colspan="8"><button type="button" data-filter="all">${r.count} accounts below threshold</button> net to ${signedUsd(r.net)} on profit: ${signedUsd(r.grossUp)} up, ${signedUsd(r.grossDown)} down.</td></tr>`;
  let body;
  if (flux.filter === "needs") body = needs.map(row).join("") + residualRow;
  else if (flux.filter === "review") body = review.length ? review.map(row).join("") : `<tr><td colspan="8" class="empty">Nothing waiting for review.</td></tr>`;
  else {
    const of = (types) => p.accounts.filter((a) => types.includes(a.type)).map(row).join("");
    const s = p.statement;
    body = of(["Income"]) + sub("Revenue", s.revenue) + of(["COGS"]) + sub("Cost of revenue", s.cogs) + sub("Gross margin", s.grossMargin) + of(["Expense"]) + sub("Operating expenses", s.expense) + sub("Operating income", s.operatingIncome) + of(["OthIncome", "OthExpense"]) + sub("Other, net", s.other) + sub("Net income", s.netIncome);
  }
  const tab = (key, label) => `<button type="button" class="fx-tab" data-filter="${key}" aria-pressed="${flux.filter === key}">${label}</button>`;
  return `<div class="fx-tabs">${tab("needs", `Needs explanation <span class="count">${needs.length}</span>`)}${tab("review", `For review <span class="count">${review.length}</span>`)}${tab("all", "Full statement")}</div>
    <div class="fx-scroll"><table class="fx-table">${head}<tbody>${body}</tbody></table></div>`;
}

// ---------- Side panel ----------
function fluxDrawer(p) {
  const a = p.accounts.find((x) => x.accountId === flux.open);
  if (!a) return "";
  const tab = (key, label) => `<button type="button" class="fx-tab" data-tab="${key}" aria-pressed="${flux.tab === key}">${label}</button>`;
  const st = fluxState(a);
  return `<aside class="fx-drawer" aria-label="${esc(a.account)}">
    <div class="fx-dhead">
      <div><div class="meta">${esc(a.flagReason ? `Flagged: ${a.flagReason}` : "Below threshold")}</div><div class="title" style="margin:2px 0 0">${esc(a.account)}</div></div>
      <div class="fx-dhead-right"><span class="fx-state ${st.key}">${esc(st.label)}</span><button type="button" class="fx-close" id="fx-close" aria-label="Close">×</button></div>
    </div>
    <div class="fx-figures">
      <div><div class="meta">${esc(p.cur.name)}</div><div class="fx-fig">${usd(a.cur)}</div></div>
      <div><div class="meta">${esc(p.prior.name)}</div><div class="fx-fig muted">${usd(a.prior)}</div></div>
      <div><div class="meta">Change</div><div class="fx-fig">${signedUsd(a.delta)} <span class="meta">${pctText(a.pct)}</span></div><div class="meta">${impactWord(a.impact)}</div></div>
    </div>
    <div class="quiet fx-whatif">Net income moved ${signedUsd(p.statement.netIncome.delta)}. Had this account stayed flat, it would have moved ${signedUsd(a.netIfFlat)}.${Math.abs(a.fx) >= 1 ? ` Currency effect here: ${signedUsd(a.fx)}, activity: ${signedUsd(a.activity)}.` : ""}</div>
    ${fluxTrend(a, p)}
    <div class="fx-tabs">${tab("explain", "Explanation")}${tab("drivers", "Breakdown")}${tab("txns", "Transactions")}${tab("history", "History")}</div>
    <div class="fx-tabbody">${{ explain: fluxExplain, drivers: fluxDrivers, txns: fluxTxns, history: fluxHistory }[flux.tab](a, p)}</div>
  </aside>`;
}

function fluxTrend(a, p) {
  if (!a.trend.length) return "";
  const max = Math.max(1, ...a.trend.map((t) => Math.abs(t.amount)));
  return `<div class="fx-trend" role="img" aria-label="${esc(a.trend.map((t) => `${t.period} ${usd(t.amount)}`).join(", "))}">
    ${a.trend.map((t) => {
      const cls = t.period === p.cur.name ? "cur" : t.period === p.prior.name ? "prior" : "";
      return `<div class="fx-tcol" title="${esc(t.period)}: ${usd(t.amount)}"><span class="fx-tval">${t.period === p.cur.name || t.period === p.prior.name ? usd(t.amount) : ""}</span><span class="fx-tbar ${cls}" style="height:${Math.max(2, (Math.abs(t.amount) / max) * 48).toFixed(0)}px"></span><span class="fx-tname">${esc(t.period.split(" ")[0])}</span></div>`;
    }).join("")}
  </div>`;
}

const CAUSE = { stated_in_record: "Stated in the record", inferred: "Inferred", unknown: "Cause unknown" };
const STATE_WORD = { traced: "Traced", partly_traced: "Partly traced", insufficient: "Not enough evidence" };

function fluxExplain(a, p) {
  const w = a.workflow;
  if (!a.flagged && !w) return `<p class="empty">This account is below the threshold, so no explanation is required. Its movement is in the residual line under the table.</p>`;
  if (!w) return `<p class="empty">Evidence was read for the largest flagged accounts only. Re-read the ledger to fetch it for this one.</p>`;
  const c = a.coverage;
  const d = w.draft;
  const backNote = w.state === "sent_back" ? w.history.filter((h) => h.action === "sent_back").at(-1) : null;
  const preparedBy = w.history.filter((h) => h.action === "prepared").at(-1)?.who;
  const samePerson = w.state === "prepared" && preparedBy === fluxWho();
  return `
    ${w.stale ? `<div class="fx-alert">Postings changed after this was written, so its sign-offs were reopened. Read it against the new figures, then save or redraft it.</div>` : ""}
    ${backNote ? `<div class="fx-alert"><b>Sent back by ${esc(backNote.who)}:</b> ${esc(backNote.note)}</div>` : ""}
    ${w.draftError ? `<div class="fx-alert">The draft failed: ${esc(w.draftError)}</div>` : ""}
    ${c ? `
      <div class="fx-coverage">
        <div class="fx-covline"><b>${STATE_WORD[c.state]}: ${Math.round(c.tracedPct * 100)}%</b><span class="quiet">of ${signedUsd(a.delta)}</span></div>
        <span class="fx-meter wide"><i class="${c.state}" style="width:${Math.round(c.tracedPct * 100)}%"></i></span>
        <div class="quiet fx-covnote">Read ${a.transactions.reduce((t, x) => t + x.lines, 0).toLocaleString("en-US")} of ${a.lines.toLocaleString("en-US")} posting lines, the largest transactions in each period.${c.state === "traced" ? "" : ` The cited transactions don't add up to the change: ${signedUsd(c.remainder)} sits elsewhere, usually in smaller postings not read individually.`}</div>
      </div>
      <p>${esc(d.summary)}</p>
      ${d.recurrence === "same_cause_as_prior" ? `<div class="quiet">This month's evidence supports last period's explanation.</div>` : d.recurrence === "different_cause" ? `<div class="quiet">Different cause from last period's explanation.</div>` : ""}
      <div class="fx-drivers">
        ${c.drivers.map((dr) => `
          <div class="fx-driver">
            <div class="fx-drow"><b>${esc(dr.label)}</b><span class="num">${signedUsd(dr.amount)}</span></div>
            <div>${esc(dr.cause)}</div>
            <div class="fx-cites"><span class="fx-cause ${dr.causeStatus}">${CAUSE[dr.causeStatus]}</span>${dr.transactionIds.map((id) => fluxCite(a, id)).join("")}</div>
          </div>`).join("")}
        <div class="fx-driver remainder"><div class="fx-drow"><b>Not traced to a transaction</b><span class="num">${signedUsd(c.remainder)}</span></div></div>
      </div>
      ${c.rejectedCitations.length ? `<div class="quiet">${c.rejectedCitations.length} citation(s) pointed at transactions not in the evidence and were dropped.</div>` : ""}
      ${d.questionForOwner ? `<div class="fx-question"><div class="meta">Ask the account owner</div>${esc(d.questionForOwner)}</div>` : ""}
    ` : `<p class="empty">${p.status === "drafting" ? "Drafting…" : "No draft yet."}</p>`}
    ${w.priorExplanation ? `<div class="fx-prior"><div class="meta">Approved last period</div>${esc(w.priorExplanation)}</div>` : ""}
    <div class="fx-write">
      <label class="meta" for="fx-text">Your explanation</label>
      <textarea id="fx-text" ${w.state === "approved" ? "disabled" : ""} placeholder="What the owner told you, or your own reading.">${esc(w.text ?? "")}</textarea>
      <div class="fx-row">
        ${w.state !== "approved" ? `<button class="btn" id="fx-save">Save</button>` : ""}
        ${w.state !== "approved" ? `<input type="text" id="fx-guidance" placeholder="Context for a new draft, e.g. July rent includes the lease true-up"><button class="btn" id="fx-redraft">Redraft</button>` : ""}
      </div>
    </div>
    <div class="fx-signoff">
      ${w.state === "open" || w.state === "sent_back" ? `<button class="btn primary" id="fx-prepare-sign">Sign off as preparer</button>` : ""}
      ${w.state === "prepared" ? `
        ${samePerson ? `<div class="fx-alert">You prepared this. A second person should review it; if you approve it anyway, the evidence packet will show the same person did both.</div>` : ""}
        <input type="text" id="fx-note" placeholder="What did you check? Required to send back.">
        <div class="fx-row"><button class="btn primary" id="fx-approve">Approve</button><button class="btn" id="fx-send-back">Send back</button></div>` : ""}
      ${w.state === "approved" ? `<input type="text" id="fx-note" placeholder="Why reopen it?"><button class="btn" id="fx-reopen">Reopen</button>` : ""}
      <div id="fx-act-err"></div>
    </div>`;
}

function fluxCite(a, id) {
  const t = a.transactions.find((x) => x.id === id);
  if (!t) return "";
  return `<a class="fx-cite" href="${esc(t.url)}" target="_blank" rel="noopener" title="${esc(`${t.date}, ${signedUsd(t.contribution)} on this change`)}">${esc(txnRef(t))}</a>`;
}

function fluxDrivers(a) {
  const dims = { subsidiary: { label: "Subsidiary" }, ...a.dimensions };
  const chips = Object.entries(dims).map(([k, d]) => `<button type="button" class="fx-chipbtn" data-dim="${k}" aria-pressed="${flux.dim === k}">${esc(d.label)}</button>`).join("");
  let values, rest = 0;
  if (flux.dim === "subsidiary") values = a.subsidiaries.map((s) => ({ value: s.subsidiary, delta: s.delta, cur: s.cur, prior: s.prior, share: a.delta ? s.delta / a.delta : null, ifFlat: a.delta - s.delta }));
  else ({ values, rest } = a.dimensions[flux.dim] ?? { values: [], rest: 0 });
  if (!values.length) return `<div class="fx-chiprow">${chips}</div><p class="empty">${a.hasEvidence ? "No postings carry this." : "Evidence was read for the largest flagged accounts only."}</p>`;
  const sign = a.impact === a.delta ? 1 : -1;
  const max = Math.max(1, ...values.map((v) => Math.abs(v.delta)));
  const top = values[0];
  const concentrated = a.delta !== 0 && top.share !== null && Math.abs(top.share) >= 0.5;
  return `<div class="fx-chiprow">${chips}</div>
    ${concentrated ? `<p class="fx-callout"><b>${esc(top.value)}</b> accounts for ${shareText(top.share)} of this change. Without it, the account would have moved ${signedUsd(top.ifFlat)}.</p>` : ""}
    <div class="fx-dimlist">${values.map((v) => `
      <div class="fx-dimrow"><span class="fx-dimname" title="${esc(v.value)}">${esc(v.value)}</span>
        <span class="fx-dbar small"><span class="fx-dfill ${impactClass(v.delta * sign)}" style="${v.delta >= 0 ? "left:50%" : "right:50%"};width:${((Math.abs(v.delta) / max) * 50).toFixed(2)}%"></span></span>
        <span class="num">${signedUsd(v.delta)}</span><span class="num muted">${shareText(v.share)}</span></div>`).join("")}
      ${Math.abs(rest) >= 1 ? `<div class="fx-dimrow muted"><span class="fx-dimname">Everything else</span><span></span><span class="num">${signedUsd(rest)}</span><span></span></div>` : ""}
    </div>`;
}

function fluxTxns(a, p) {
  if (!a.hasEvidence) return `<p class="empty">Evidence was read for the largest flagged accounts only.</p>`;
  const group = (rows, name, total) => {
    const listed = rows.reduce((t, r) => t + r.amount, 0);
    return `<div class="fx-section-title small">${esc(name)} <span class="quiet">largest ${rows.length}, ${total ? `${Math.round(Math.min(1, Math.abs(listed / total)) * 100)}% of the period's ${usd(total)}` : "no balance"}</span></div>
      ${rows.length ? rows.map((t) => `<a class="fx-txn" href="${esc(t.url)}" target="_blank" rel="noopener">
        <span class="fx-txnmain"><b>${esc(txnRef(t))}</b> <span class="quiet">${esc(t.date)}${t.entity ? ` · ${esc(t.entity)}` : ""}${t.lines > 1 ? ` · ${t.lines.toLocaleString("en-US")} lines` : ""}</span>${t.memo ? `<span class="fx-memo">${esc(t.memo)}</span>` : `<span class="fx-memo none">No memo</span>`}</span>
        <span class="num">${usd(t.amount)}</span></a>`).join("") : `<p class="empty">None.</p>`}`;
  };
  return group(a.transactions.filter((t) => t.inCurrent), p.cur.name, a.cur) + group(a.transactions.filter((t) => !t.inCurrent), p.prior.name, a.prior);
}

const ACTION_WORD = { drafted: "Draft written", redrafted: "Redrafted", edited: "Explanation edited", prepared: "Signed off by preparer", approved: "Approved", sent_back: "Sent back", reopened: "Reopened", ledger_changed: "Ledger changed", threshold_changed: "Threshold changed", evidence_added: "Evidence added" };

function fluxHistory(a) {
  const h = a.workflow?.history ?? [];
  return `${h.length ? h.slice().reverse().map((e) => `<div class="fx-hist"><div><b>${esc(ACTION_WORD[e.action] ?? e.action)}</b> <span class="quiet">${esc(e.who)} · ${esc(when(e.at))}</span></div>${e.note ? `<div>${esc(e.note)}</div>` : ""}<div class="meta">Ledger state ${esc(e.ledgerHash)}</div></div>`).join("") : `<p class="empty">Nothing yet.</p>`}
    <details class="fx-policy inner"><summary>Set this account's threshold</summary>
      <div class="fx-form"><label>Amount<input type="text" id="fx-o-amount"></label><label>Percent<input type="text" id="fx-o-percent"></label><label class="fx-grow">Reason<input type="text" id="fx-o-reason"></label><button class="btn" id="fx-o-save">Set</button></div><div id="fx-o-err"></div>
    </details>`;
}

// ---------- Wiring ----------
function wirePack() {
  const p = flux.pack;
  const post = async (path, body) => {
    flux.pack = await api("POST", `/api/flux/packs/${p.id}/${path}`, body);
    renderPack();
  };
  document.querySelectorAll("[data-open]").forEach((el) => {
    const open = () => { flux.open = Number(el.dataset.open); flux.tab = "explain"; renderPack(); };
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === "Enter") open(); };
  });
  document.querySelectorAll("[data-filter]").forEach((el) => (el.onclick = () => { flux.filter = el.dataset.filter; renderPack(); }));
  document.querySelectorAll("[data-tab]").forEach((el) => (el.onclick = () => { flux.tab = el.dataset.tab; renderPack(); }));
  document.querySelectorAll("[data-dim]").forEach((el) => (el.onclick = () => { flux.dim = el.dataset.dim; renderPack(); }));
  if ($("fx-who")) $("fx-who").onchange = (e) => { setFluxWho(e.target.value.trim() || "dja0086"); renderPack(); };
  if ($("fx-close")) $("fx-close").onclick = () => { flux.open = null; renderPack(); };
  $("fx-export").onclick = () => busy($("fx-export"), $("fx-page-note"), async () => {
    const res = await fetch(`/api/flux/packs/${p.id}/export`, { headers: { "X-Builder-Token": TOKEN } });
    if (!res.ok) throw new Error("The evidence packet could not be built.");
    const name = (res.headers.get("Content-Disposition") ?? "").match(/filename="(.+)"/)?.[1] ?? "flux-evidence.csv";
    const url = URL.createObjectURL(await res.blob());
    const link = Object.assign(document.createElement("a"), { href: url, download: name });
    link.click();
    URL.revokeObjectURL(url);
  });
  $("fx-reread").onclick = () => busy($("fx-reread"), $("fx-page-note"), async () => {
    await api("POST", "/api/flux/prepare", { cur: p.cur.id, prior: p.prior.id, who: fluxWho() });
    route();
  });
  $("fx-p-save").onclick = () => busy($("fx-p-save"), $("fx-p-err"), () => post("policy", {
    who: fluxWho(), reason: $("fx-p-reason").value, mode: $("fx-p-mode").value,
    amount: Number($("fx-p-amount").value.replace(/[,$\s]/g, "")), percent: Number($("fx-p-percent").value.replace(/[%\s]/g, "")) / 100,
    ...($("fx-p-always").value.trim() ? { alwaysAmount: Number($("fx-p-always").value.replace(/[,$\s]/g, "")) } : {}),
  }));
  if (flux.open === null) return;
  const accountId = flux.open;
  const who = fluxWho();
  const errBox = () => $("fx-act-err");
  const note = () => $("fx-note")?.value.trim() ?? "";
  const wire = (id, fn) => { if ($(id)) $(id).onclick = () => busy($(id), errBox(), fn); };
  wire("fx-save", () => post("action", { type: "edit", accountId, who, text: $("fx-text").value }));
  wire("fx-redraft", () => {
    const guidance = $("fx-guidance").value.trim();
    if (!guidance) throw new Error("Add the context the new draft should use.");
    return post("redraft", { accountId, who, guidance });
  });
  wire("fx-prepare-sign", () => post("action", { type: "prepare", accountId, who }));
  wire("fx-approve", () => post("action", { type: "approve", accountId, who, ...(note() ? { note: note() } : {}) }));
  wire("fx-send-back", () => {
    if (!note()) throw new Error("Say what needs another look before sending it back.");
    return post("action", { type: "send_back", accountId, who, note: note() });
  });
  wire("fx-reopen", () => {
    if (!note()) throw new Error("Say why it is being reopened.");
    return post("action", { type: "reopen", accountId, who, note: note() });
  });
  if ($("fx-o-save")) $("fx-o-save").onclick = () => busy($("fx-o-save"), $("fx-o-err"), () => {
    const amount = $("fx-o-amount").value.trim();
    const percent = $("fx-o-percent").value.trim();
    return post("policy", { who, accountId, reason: $("fx-o-reason").value, ...(amount ? { amount: Number(amount.replace(/[,$\s]/g, "")) } : {}), ...(percent ? { percent: Number(percent.replace(/[%\s]/g, "")) / 100 } : {}) });
  });
}

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && flux.open !== null && (location.hash || "").startsWith("#/flux/")) { flux.open = null; renderPack(); }
});

async function fluxView(id) {
  if (id) { flux.open = null; await fluxPack(id); } else await fluxHome();
}
