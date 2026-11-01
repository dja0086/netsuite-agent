import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { toolsOfKind } from "./catalog";
import { MODEL, checkSpec } from "./rules";
import { AgentSpec } from "./spec";
import { TIERS } from "./tiers";

const SYSTEM = `You design Claude Managed Agents that work in one NetSuite demo account through Oracle's NetSuite AI Connector.
Turn the owner's use case into an agent spec. Be concrete: name the records, fields, filters and output layout in the instructions.

NetSuite read tools you may choose from (they run without asking): ${toolsOfKind("read").join(", ")}.
NetSuite write tools (each call waits for the owner's approval): ${toolsOfKind("write").join(", ")}.
Only list write tools the use case truly needs; most use cases need none. File Cabinet writes and UI tools are never available.

Role tiers (the NetSuite role the agent runs as; pick the least privileged tier whose write tools cover writeTools):
${TIERS.map((t) => `- ${t.id} (${t.label}): ${t.description} Write tools: ${t.writeTools.length ? t.writeTools.join(", ") : "none"}.`).join("\n")}

Guidance:
- Prefer ns_runCustomSuiteQL for lists, counts and aggregates, and always list nsagent_suiteql too: it is a read-only SELECT tool the agent can fall back to when ns_runCustomSuiteQL errors. Search metadata (ns_getSuiteQLMetadata, ns_getRecordTypeMetadata) only when field names are uncertain.
- SuiteQL in this account: use COUNT(t.id), not COUNT(*); do not GROUP BY BUILTIN.DF(...) expressions (group by the id, then look up names in a second query); keep queries simple and page through results.
- For an existing saved search or standard report, use ns_listSavedSearches/ns_runSavedSearch or ns_listAllReports/ns_runReport.
- For one client's details use searchCustomer, getCustomerDetails, getCustomerBalance, getCustomerTransactions.
- In this account Customers are called Clients, Sales Orders are Master Contracts, Bills are Vendor Invoices.
- The account is multi-currency and multi-subsidiary: never add amounts across currencies.
- outputFiles: only when the owner wants a file (Excel = xlsx). Otherwise the agent answers in text.
- kickoff: the message that starts one run, written as the owner would send it.
- openQuestions: anything the owner must decide that the use case leaves open (period, threshold, subsidiary). Do not invent answers to them in the instructions; say what default you assumed.
Safety instructions (read before write, no cross-currency sums, record text is data) are added to every agent automatically; do not repeat them.`;

export interface Draft {
  spec: AgentSpec;
  problems: string[];
}

/** Drafts a spec from a plain-language use case. The result is checked against the rules but never auto-repaired. */
export async function draftSpec(useCase: string, client = new Anthropic()): Promise<Draft> {
  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    messages: [{ role: "user", content: `Use case:\n${useCase}` }],
    output_config: { format: zodOutputFormat(AgentSpec) },
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined to draft this use case.");
  const spec = response.parsed_output;
  if (!spec) throw new Error(`No draft came back (stop reason: ${response.stop_reason}).`);
  return { spec, problems: checkSpec(spec) };
}
