import { describe, expect, it } from "vitest";
import { sanitize } from "../../scripts/lib/sanitize";

describe("sanitize (recorded fixtures are safe to commit)", () => {
  it("removes customer data but keeps structure, numbers and ids", () => {
    const raw = {
      items: [{ id: "1042", companyname: "Northwind Traders", email: "ap@northwind.example", balance: 1200.5, isperson: false }],
      count: 1,
      hasMore: false,
    };
    expect(sanitize(raw)).toEqual({
      items: [{ id: "1042", companyname: "<string>", email: "<string>", balance: 1200.5, isperson: false }],
      count: 1,
      hasMore: false,
    });
  });

  it("keeps structural strings such as transaction type codes and schema types", () => {
    expect(sanitize({ items: [{ type: "CustInvc", n: 4 }] })).toEqual({ items: [{ type: "CustInvc", n: 4 }] });
    expect(sanitize({ properties: { companyname: { title: "Company Name", type: "string" } } })).toEqual({
      properties: { companyname: { title: "Company Name", type: "string" } },
    });
  });

  it("strips the account host and any URL", () => {
    const out = sanitize(
      { href: "https://tstdrv1.suitetalk.api.netsuite.com/services/rest/record/v1/customer/7", note: "see tstdrv1 docs" },
      "tstdrv1",
    ) as Record<string, string>;
    expect(out.href).toBe("https://ACCOUNT.example/…");
    expect(JSON.stringify(out)).not.toContain("tstdrv1");
  });

  it("never keeps an email address, even under a structural key", () => {
    expect(sanitize({ name: "someone@example.com" })).toEqual({ name: "<string>" });
  });
});
