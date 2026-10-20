/**
 * pnpm ns:ping
 * Checks the OAuth 2.0 M2M setup end to end: token request, one SuiteQL query, metadata catalog,
 * and (if deployed) the explore RESTlet. Read-only. Prints no secrets.
 */
import { callRestlet, listRecordTypes, NsClient, NsHttpError, suiteql } from "@ns-agent/ns-client";

const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
  try {
    console.log(`ok    ${name}: ${await fn()}`);
    return true;
  } catch (error) {
    const detail =
      error instanceof NsHttpError ? `HTTP ${error.status} ${error.code ?? ""} ${error.message}` : (error as Error).message;
    console.log(`FAIL  ${name}: ${detail}`);
    return false;
  }
};

const ns = NsClient.fromEnv();
console.log(`Account ${ns.config.accountId} -> ${ns.config.restBaseUrl}\n`);

const tokenOk = await step("token", async () => {
  await ns.request({ method: "GET", base: "rest", path: "/services/rest/record/v1/metadata-catalog", query: { select: "customer" } });
  return "access token issued and accepted";
});
if (!tokenOk) {
  console.log(`
Token failures usually mean one of:
  - "fetch failed": NS_ACCOUNT_ID is wrong (the account host does not exist) or the network blocks NetSuite
  - NS_CLIENT_ID is not the integration record's Client ID (Consumer Key)
  - NS_CERT_ID is not the Certificate ID from the M2M setup page
  - the private key does not match the uploaded certificate, or the mapping was revoked/expired
  - the integration record is missing the Client Credentials grant, or the REST Web Services / RESTlets scope
  - the role lacks "Log in using OAuth 2.0 Access Tokens"`);
  process.exit(1);
}

let ok = true;
ok &&= await step("suiteql", async () => {
  const page = await suiteql<{ n: number }>(ns, "SELECT COUNT(id) AS n FROM customer", { limit: 1 });
  return `${page.items[0]?.n ?? 0} customers visible to the integration role`;
});
ok &&= await step("metadata catalog", async () => `${(await listRecordTypes(ns)).length} record types visible`);
const restletOk = await step("explore RESTlet (optional until deployed)", async () => {
  const res = await callRestlet<{ count: number }>(ns, {
    scriptId: "customscript_ns_agent_explore_rl",
    deployId: "customdeploy_ns_agent_explore_rl",
    body: { action: "globalSearch", keywords: "a", limit: 1 },
  }).catch((e: unknown) => {
    // "a" is too short for the RESTlet; a NS_AGENT_BAD_INPUT error proves it is deployed and reachable.
    if (e instanceof NsHttpError && e.code === "NS_AGENT_BAD_INPUT") return { count: -1 };
    throw e;
  });
  return res.count === -1 ? "deployed and reachable" : `reachable (${res.count} results)`;
});

console.log(`\nLimiter: ${JSON.stringify(ns.limiter.snapshot())}`);
console.log(ok ? `\nM2M setup works${restletOk ? "" : " (RESTlet not deployed yet; that is expected before the first SDF deploy)"}.` : "\nSetup incomplete; see failures above.");
process.exit(ok ? 0 : 1);
