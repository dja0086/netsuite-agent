# Flux analysis: design and what backs it

Built 2026-11-01. Using it: `docs/agent-builder.md`, "Flux analysis". Code: `apps/agent-builder/src/flux/`, `public/flux.js`.

## Worked backwards from

A preparer pulls comparatives, applies thresholds, checks last month's words and the transactions, asks the owner, writes the driver. A reviewer challenges weak explanations and signs off. Time goes to exporting data, rebuilding explanations and chasing context ([Numeric](https://numeric.io/blog/should-you-give-a-flux-about-flux-analysis), vendor; [CFO Shortlist](https://www.cfoshortlist.com/reports/what-is-flux-analysis), practitioner). Most tools already flag variances and draft text. **What separates them is whether the reviewer can test an explanation quickly.** So the design goal is not "AI commentary" but evidence a controller can check.

## Decisions, and why

| Decision | Why |
| --- | --- |
| Code computes every number; the model only groups transactions and writes words, and text containing figures is refused | Practitioners' main complaints are drafts that restate direction and "right numbers, wrong cause" ([Nominal](https://www.nominal.so/blog/flux-analysis), vendor). Hallucinated figures become impossible by construction. |
| Each driver is priced from the transactions it cites; drivers plus an always-visible remainder equal the change; a meter shows how much is traced | Citations and sum-to-total are the most inspectable pattern found ([Microsoft Finance Agent](https://learn.microsoft.com/en-us/copilot/finance/variance/analyze-variances), docs). A model confidence score was rejected in favour of evidence states. |
| Each cause is labelled stated in the record, inferred, or unknown, with a specific question for the owner | "GL detail records what was posted, not why" ([Ramp](https://ramp.com/answers/flux-variance-analysis/variance-explanations-drafted-general-ledger-detail), vendor). Drafts struggle with diffuse activity ([DualEntry](https://docs.dualentry.com/accountants/core-financials/close-management/flux-analysis), docs). |
| Rows are read from the session's tool results, and only for a query matching ours exactly | The reader model never retypes a number and can't change a query. |
| Totals are tied to a separate ledger query, shown on the page | Totals that don't tie are a top reason variance screens lose trust. |
| Activity and FX are split per subsidiary at NetSuite's rates, and add back to the change | OneWorld decomposition was the clearest gap in documented products. Constant-currency method per [Oracle](https://docs.oracle.com/en/cloud/saas/tax-reporting-cloud/ustrc/analyzing_constant_currency.html), docs. |
| Thresholds: amount and percent, an always-flag amount, per-account overrides; no percent on a zero or negative base; changes after results need a reason, which goes in the packet | Thresholds moved after seeing results and flat rules are named failures (CFO Shortlist). The always-flag amount came from testing: "both" hid a $793,099 revenue move at +6.2%. |
| A residual line says what fell below the threshold, gross up and down | Unflagged movements can add up. This line is how the $793,099 miss was found. |
| Bridge: top movers, plus gross increases and decreases, never one net "Other" | A net Other hides offsets. Top N from [Power BI](https://learn.microsoft.com/en-us/power-bi/visuals/power-bi-visualization-waterfall-charts) and [Zebra BI](https://help.zebrabi.com/overview-of-the-zebra-bi-tables-visual), docs. |
| Rows: impact colour from account type, arithmetic sign kept, "n.a." on bad bases, share of net change, what-if | [IBCS](https://www.ibcs.com/resource/table-template-04/), [Zebra Invert](https://help.zebrabi.com/overview-of-the-zebra-bi-tables-visual), [ThoughtSpot](https://docs.thoughtspot.com/cloud/latest/spotiq-change), docs. |
| Side panel keeps the table in view; pivot by subsidiary, department, class, location, client or vendor, item; source records open in NetSuite | Pivot in place from ThoughtSpot and the [Power BI tree](https://learn.microsoft.com/en-us/power-bi/visuals/power-bi-visualization-decomposition-tree), docs. Unexplained AI splits were avoided. |
| Each explanation is pinned to a fingerprint of the account's ledger state; a re-read that changes it reopens sign-offs | Staleness flag from [Double](https://help.doublehq.com/en/articles/15024367-ai-flux-analysis), docs. Sign-off only after re-reading. |
| Preparer, then reviewer; send-backs need a note; approval locks; same-person sign-off is flagged; a draft with too little evidence can't be signed off without a person's words | "An unreviewed flux is documentation, not a control" (CFO Shortlist). Reviewer challenge is the audit evidence ([Optro](https://optro.ai/blog/the-management-review-control-dilemma), practitioner, 2017). |
| Last period's approved words are shown beside this month's evidence, never accepted without it | Carry-forward without revalidation wasn't documented anywhere found. |

## How far the evidence goes

No product was used hands-on, no demos were watched, and no practitioner forum could be read (Reddit, G2 and TrustRadius were unavailable to the tools). Much of the above is vendor documentation or marketing. Nobody from a real finance team has seen this yet: that is the next real test.

Oracle offers overlapping free pieces: `netsuite-variance-analysis` in its [SuiteSkills runbooks](https://github.com/oracle/netsuite-suitecloud-sdk/tree/ai-plugins-dist), and an Intelligent Flux Analysis feature that partners place on the Comparative Income Statement. A controlled review workflow around them wasn't documented.

## Verified live (demo account, 2026-11-01)

- Jul 2017 vs Jun 2017: net income +$1,724,798, matching a separate hand check from direct SuiteQL; the page's tie-out to the ledger total passed.
- About two minutes end to end. The reader session reported 7 cents; 11 drafts used about 59K input and 17K output tokens. Those draft calls sit outside the session's $5 cap, and evidence is limited to 24 accounts to bound them.
- 9 of 11 flagged accounts trace 97-100% of their change. Sign-off, send-back, approve, lock, same-person warning and the evidence packet were clicked through.

## Known limits

- **FX is proved by tests only.** This account's consolidated rates are identical in every period checked, so the live split is always $0.
- **Evidence reads the 25 largest transactions per account per period.** `4001 Client Ad Revenue` traces 0%: July's top 25 cover $10.3M of $13.6M, and the screen says so. No "read more" yet.
- **Consolidated view only.** No subsidiary-scope view or local-currency view yet. Comparisons are single periods: no quarter, YTD or budget.
- **Periods come from postings**, since the role can't read `accountingperiod`. A period with no postings isn't listed, and open or closed status isn't known.
- **Who signed is typed, not authenticated.** Fine for one owner on a demo account; not a control for a real team until the builder has real sign-in (ADR 0007, "Revisit if"). The history is a local file, not tamper-proof.
- **The reader uses the Clerk sign-in** until the Read-only tier is signed in; that agent has every write tool disabled either way.
- **Demo data:** most of July sits in large imported journals with no memo, so many answers are correctly "ask the owner".
