# Plan: agents that finish the job

Status: **plan only, nothing built.** Owner direction 2026-11-01: flux first, then this. First workflow: collections.

## The gap this closes

Today every agent ends at a file or a single approved write. The weekly agent finds 499 invoices over 60 days across 140 clients, and then nothing happens because of it. Oracle's free runbooks already rank and draft collections work, keeping drafts as proposals; no Oracle AI product found sends collections email or makes bulk changes, and the connector has no email or bulk tool. **So the opening is controlled execution, not more analysis.**

Be honest about competition: approve-before-send is not unique. Tesorio (from about $30K a year) and Billtrust offer it, and Upflow was listed at $440-880 a month in 2024. For one real team, the question is whether this beats buying one of those: that depends on fit with how they already work in NetSuite, which only they can answer.

## What it looks like

1. **Overnight:** a scheduled agent reads open receivables and builds a queue: per client, what's overdue, what's already been said, payment history, a proposed next step and a draft message. Disputed or recently paid accounts are held out with the reason.
2. **Morning:** a collector opens one Work Queue. Each row shows the action, its evidence and the exact message. They edit, exclude, or approve in one pass.
3. **Execution:** the builder runs only rows matching what was approved; any difference comes back to a person. Sends go out, and activity is logged in NetSuite.
4. **Replies:** replies are read in isolation, classified (promise to pay, dispute, paid, wrong contact) and turned into proposals in the next queue.
5. **Closing the loop:** next week's queue shows what moved: dollars past 60 days, promises kept, replies waiting.

## What carries over from flux

Exact-query reader, code-computed figures with text refused if it holds figures, evidence labelled stated or inferred or unknown, ledger fingerprints (an invoice paid after drafting makes its row stale, and it must never send), preparer and reviewer trail, evidence export.

## Phases

| Phase | Delivers | Done when |
| --- | --- | --- |
| 0. Prove the risky parts on demo | Exact-match batch approval on 40 proposed writes; one custom send tool to a test inbox; concurrency against the request limit; the 168-hour sign-in check (2026-11-06/07) | A changed row is refused every time; a batch survives a builder restart |
| 1. Collections queue, read-only | The queue and drafted messages, nothing sent. Try Oracle's `netsuite-invoice-collections` runbook as the analysis, after checking its licence | A collector says it matches what they'd do, on a real ageing list |
| 2. Work Queue with NetSuite actions | Batch approval of notes and follow-up tasks | Hours per week measured against the team's baseline |
| 3. Sending | Builder-run send tool: recipient must be the client's address on record, rate limited, with a suppression list | No send to a paid or disputed invoice in a pilot |
| 4. Replies | Reader with no write tools turns replies into proposals | Reply handling measured; no instruction in a reply changes behaviour |

## Risks that shape the design

- **Dunning a client who already paid** is the worst failure. Re-read the invoice immediately before each send, not at draft time.
- **Replies are outside text** that could carry instructions into an agent with write tools. Keep reading and writing in separate agents.
- **The builder must be hosted.** Writes and sends would run through it, and today it's on one Mac and the desktop app can stop it. If it's down, runs wait safely, but nothing moves.
- **Emails read as spam** is a real complaint against Upflow. Messages need to come from the collector's own mailbox and sound like them.

## Decisions for the owner

1. **Which finance team, and on which NetSuite account?** Rules today allow only the demo account, and account 9173162 is explicitly excluded. ADR 0007's "revisit if" conditions all apply: several people, a real account, bulk writes. So redaction, separate approvers and audit retention have to come back first.
2. **Rule changes:** custom tools are refused today (`assertConfigSafe`) and the only allowed server is NetSuite. A send tool needs your decision. Same for one approval covering a batch: the rule says the owner approves "that exact request", and an exact-match list keeps that meaning but changes how it's given.
3. **Which mailbox and which provider** sends and reads replies?
4. **Use NetSuite's own dunning letters for some steps?** They already send template email (no AI found). Simpler for early reminders; the agent could own only the judgement calls.

## Measures for a pilot

Dollars past 60 days, overdue invoices touched per week, collector hours, promises to pay kept, sends to wrong or already-paid clients (target zero). DSO is too slow for a short pilot.
