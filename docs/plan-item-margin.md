# Plan: exploded item cost and allocated contribution margin

Status: **plan only, nothing built.** Owner direction 2026-11-01: exploded item cost, a contribution margin bridge by item, item categories and locations, and certain GL expense accounts "allocated" for analysis only, using allocation methods, for margin insight.

## The answer it gives

"Which items, categories and locations actually make money once real costs land on them, and what moved that since last period?" Flux explains accounts; this explains margin. The Item pivot in the flux panel is the natural way in.

## How the numbers are built

| Level | What's in it | Source |
| --- | --- | --- |
| Revenue | Net revenue by item, quantity, price | Invoice and credit memo lines |
| CM1 | Less exploded product cost: material, labour and overhead per unit, rolled up through the BOM | BOM revision at the transaction date; cost basis below |
| CM2 | Less other direct cost: freight, commissions, rebates tied to the sale | Ledger lines with an item, or a rule |
| CM3 | Less allocated expenses | Allocation rules, **analysis only** |

Compared to posted COGS, the difference between exploded cost and the ledger is shown as its own line. It's useful in itself: purchase variances, stale standards, unposted cost.

## The bridge

Revenue and margin walk from one period to the next: **price, volume, mix, unit cost, other direct cost, allocated cost, FX**. Each step is computed per item and rolled up. Like flux, the pieces must sum to the total with any remainder shown, the total ties to the ledger where it can, and every bar drills to items and then transactions. New and discontinued items get their own step, since they have no price or volume to compare.

## Allocations, for analysis only

These **never write to NetSuite**. They live in the builder and are always labelled as allocated.

- **Rule:** a pool of GL accounts (optionally by department or subsidiary), a method, a target (item, category, location), and effective dates. Rules are versioned, and a pack records which version it used.
- **Methods to start:** share of revenue, share of quantity, share of direct cost, share of gross margin, fixed percentages, weight or labour hours where an item field holds them.
- **Reconciliation:** allocated amounts must sum exactly to the pool; anything with no target is shown as "unallocated" and never quietly spread. Pool totals tie to the ledger.
- **Sensitivity:** switch a method and see which items change rank. If the answer flips on the method, the screen should say so; that's the insight, and the honest warning, in allocated margin.
- **Avoiding circularity:** allocating by share of margin depends on margin before that pool. Rules run in a stated order.

## What the demo account can and can't prove

Checked with read-only SuiteQL on 2026-11-01:

| Check | Result | Meaning |
| --- | --- | --- |
| Items on ledger lines, Jul 2017 | 482 of 3,147 income lines, 147 of 6,870 COGS lines | Most of the ledger is imported journals with no item, so ledger-based item margin would be thin here |
| Items on posted invoices | 2,333 of 2,405 lines | Revenue, quantity and price by item work |
| Cost estimate on posted lines | 0 lines | No line-level cost to use |
| Active items with a cost | 129 of 427; average cost on 3 | Standard-cost margin covers a minority of items |
| Assembly items | None among active or inactive item types | **No BOM to explode here** |
| `bom` record | "Not found" for the current role | May be permission, feature, or both; not settled |
| Location, class, department on lines | Largely present on July COGS and income | The location view works |

**So exploded cost cannot be proved on this account.** Revenue by item, category and location can, and so can the allocation engine and the price-volume-mix arithmetic. Proving explosion needs an account with real assemblies, or test items and BOMs added through an approved SDF or data path, or the finance team's own account.

## Phases

| Phase | Delivers | Done when |
| --- | --- | --- |
| 0. Data check on the real account | Read-only: BOMs, revisions, cost categories, standard cost, kits, landed cost, how COGS posts by item; role permissions needed, added through `roles/tiers.json` | A one-page answer on what exists, and the cost basis chosen with the team |
| 1. Item margin and bridge | Revenue through CM2 by item, category and location; PVM bridge; ties to the ledger; opened from flux | The team reconciles one period to their own numbers |
| 2. Allocations | Rules, methods, versioning, reconciliation, sensitivity | Every pool ties out, and the team agrees the methods |
| 3. Exploded cost | BOM roll-up, CM1, exploded vs posted COGS line | One product family matches a known cost sheet |

Phase 3 comes after 2 only because it depends most on data we can't see yet. If the team's real question is about manufactured products, phase 0 may reorder this.

## Decisions for the owner

1. **Cost basis:** standard, average, or actual purchase? It changes every margin figure. Likely per-team.
2. **Which BOM:** the revision effective on the sale date, or current? Date-effective is right, and harder.
3. **Which GL accounts are pools, and which methods** are acceptable? Finance should own these rules, because they are judgement, not arithmetic.
4. **Where this runs:** like item 2, a real team needs a real account and hosting.

## Open technical questions

- How much data one read can carry: the tool returns 200 rows, and item by location by period can far exceed that. This likely needs a query-split strategy, or an agent working in a sandbox with its results stored, instead of the flux reader's pattern.
- Query limits at item level: not yet tested against the account's 5 concurrent requests.
- Credits, returns and kits: quantity signs are negative on posted invoice lines, and group items need member handling (420 of the 451 `itemmember` rows did not join to a visible item under this role, unexplained).
