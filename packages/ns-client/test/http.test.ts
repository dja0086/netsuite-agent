import { describe, expect, it } from "vitest";
import { GovernanceLimiter, NsClient, NsHttpError, buildConfig, callRestlet, createRecord, deleteRecord, getRecord } from "../src";

function client(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let invalidated = 0;
  let tokenN = 0;
  const ns = new NsClient({
    config: buildConfig({ accountId: "1234567_SB1", clientId: "c", certId: "k" }),
    tokens: { getToken: async () => `t${++tokenN}`, invalidate: () => void invalidated++ },
    limiter: new GovernanceLimiter({ maxConcurrency: 1, sleep: async () => {} }),
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error("unexpected request");
      return next();
    }) as unknown as typeof fetch,
  });
  return { ns, calls, invalidated: () => invalidated };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("NsClient", () => {
  it("builds sandbox hostnames from the account id", () => {
    const { ns } = client([]);
    expect(ns.config.restBaseUrl).toBe("https://1234567-sb1.suitetalk.api.netsuite.com");
    expect(ns.config.restletBaseUrl).toBe("https://1234567-sb1.restlets.api.netsuite.com");
  });

  it("sends the bearer token and refreshes it once after a 401", async () => {
    const { ns, calls, invalidated } = client([() => new Response("", { status: 401 }), () => json({ id: "1" })]);
    await expect(getRecord(ns, "customer", "1")).resolves.toEqual({ id: "1" });
    expect(invalidated()).toBe(1);
    expect((calls[1]!.init.headers as Record<string, string>).Authorization).toBe("Bearer t2");
  });

  it("retries a 429 through the limiter", async () => {
    const { ns, calls } = client([() => new Response("", { status: 429 }), () => json({ id: "7" })]);
    await expect(getRecord(ns, "customer", "7")).resolves.toEqual({ id: "7" });
    expect(calls).toHaveLength(2);
  });

  it("surfaces NetSuite error codes", async () => {
    const { ns } = client([
      () => json({ "o:errorDetails": [{ detail: "Record not found", "o:errorCode": "NONEXISTENT_ID" }] }, 404),
    ]);
    const err = await getRecord(ns, "customer", "999").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NsHttpError);
    expect(err).toMatchObject({ status: 404, code: "NONEXISTENT_ID" });
  });

  it("supports external ids", async () => {
    const { ns, calls } = client([() => json({ id: "5" })]);
    await getRecord(ns, "customer", "eid:CUST-001", { fields: ["companyname"] });
    expect(calls[0]!.url).toBe(
      "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer/eid:CUST-001?fields=companyname",
    );
  });

  it("restores the internal id that NetSuite omits when fields are requested", async () => {
    const { ns } = client([() => json({ companyName: "Acme" }), () => json({ companyName: "Acme" })]);
    await expect(getRecord(ns, "customer", "42", { fields: ["companyname"] })).resolves.toEqual({ id: "42", companyName: "Acme" });
    await expect(getRecord(ns, "customer", "eid:CUST-001", { fields: ["companyname"] })).resolves.toEqual({ companyName: "Acme" });
  });

  it("creates a record with POST and returns the new internal id from the Location header", async () => {
    const { ns, calls } = client([
      () =>
        new Response(null, {
          status: 204,
          headers: { location: "https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer/2901" },
        }),
    ]);
    await expect(createRecord(ns, "customer", { companyName: "Acme", subsidiary: { id: "1" } })).resolves.toEqual({ id: "2901" });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ companyName: "Acme", subsidiary: { id: "1" } });
  });

  it("fails clearly when a create returns no Location", async () => {
    const { ns } = client([() => new Response(null, { status: 204 })]);
    await expect(createRecord(ns, "customer", {})).rejects.toThrow(/no record id/);
    await expect(createRecord(ns, "bad type!", {})).rejects.toThrow(/Invalid record type/);
  });

  it("deletes one record by internal id with DELETE", async () => {
    const { ns, calls } = client([() => new Response(null, { status: 204 })]);
    await expect(deleteRecord(ns, "customer", "2828")).resolves.toBeUndefined();
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://1234567-sb1.suitetalk.api.netsuite.com/services/rest/record/v1/customer/2828");
    await expect(deleteRecord(ns, "customer", "eid:x")).rejects.toThrow(/internal id/);
  });

  it("calls RESTlets on the restlets host and validates ids", async () => {
    const { ns, calls } = client([() => json({ ok: true })]);
    await callRestlet(ns, { scriptId: "customscript_ns_agent_explore_rl", deployId: "customdeploy_ns_agent_explore_rl", body: { a: 1 } });
    expect(calls[0]!.url).toContain("https://1234567-sb1.restlets.api.netsuite.com/app/site/hosting/restlet.nl?");
    expect(calls[0]!.url).toContain("script=customscript_ns_agent_explore_rl");
    await expect(callRestlet(ns, { scriptId: "evil", deployId: "customdeploy_x" })).rejects.toThrow(/script id/);
  });

  it("rejects invalid record types before calling NetSuite", async () => {
    const { ns, calls } = client([]);
    await expect(getRecord(ns, "customer/../../x", "1")).rejects.toThrow(/record type/);
    expect(calls).toHaveLength(0);
  });
});
