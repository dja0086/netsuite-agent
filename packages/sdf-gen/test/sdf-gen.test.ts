import { describe, expect, it } from "vitest";
import { SdfSpecError, fieldArtifact, templateArtifact, withRequiredFeatures } from "../src";

const INVOICE_SOURCE = `<?xml version="1.0"?>
<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">
<pdf>
  <head><style>th { background-color: #eeeeee; }</style></head>
  <body size="Letter">
    <h1>\${record.tranid}</h1>
    <table width="100%">
      <#list record.item as line>
        <tr><td>\${line.item}</td><td align="right">\${line.amount}</td></tr>
      </#list>
    </table>
  </body>
</pdf>`;

describe("fieldArtifact", () => {
  it("builds a body checkbox", async () => {
    const a = fieldArtifact({
      kind: "body",
      name: "rush",
      label: "Rush order",
      type: "CHECKBOX",
      appliesTo: ["sale"],
      help: "Tick when the order ships the same day.",
    });
    expect(a.scriptId).toBe("custbody_nsagent_rush");
    expect(a.features).toEqual([]);
    expect(a.files.map((f) => f.path)).toEqual(["fields/custbody_nsagent_rush.xml"]);
    await expect(a.files[0]!.content).toMatchFileSnapshot("golden/custbody_nsagent_rush.xml");
  });

  it("builds an entity select and an item text field, collecting features", async () => {
    const entity = fieldArtifact({
      kind: "entity",
      name: "account_manager",
      label: "Account manager",
      type: "SELECT",
      selectRecordType: "-4",
      appliesTo: ["customer", "partner"],
    });
    expect(entity.features).toEqual(["CRM"]);
    await expect(entity.files[0]!.content).toMatchFileSnapshot("golden/custentity_nsagent_account_manager.xml");

    const item = fieldArtifact({ kind: "item", name: "hazmat_class", label: "Hazmat class", type: "TEXT", appliesTo: ["inventory", "assembly"] });
    expect(item.features).toEqual(["ASSEMBLIES", "INVENTORY"]);
    await expect(item.files[0]!.content).toMatchFileSnapshot("golden/custitem_nsagent_hazmat_class.xml");
  });

  it("escapes text", () => {
    const a = fieldArtifact({ kind: "body", name: "note", label: `A <b> & "c"`, type: "TEXT", appliesTo: ["sale"] });
    expect(a.files[0]!.content).toContain("<label>A &#60;b&#62; &#38; &#34;c&#34;</label>");
  });

  it("allows names up to the script ID limit", () => {
    expect(fieldArtifact({ kind: "body", name: "a".repeat(21), label: "x", type: "TEXT", appliesTo: ["sale"] }).scriptId).toHaveLength(38);
    expect(fieldArtifact({ kind: "entity", name: "a".repeat(21), label: "x", type: "TEXT", appliesTo: ["customer"] }).scriptId).toHaveLength(40);
  });

  it.each([
    [{ name: "a".repeat(22) }, "at most 21 characters"],
    [{ name: "Rush" }, "lowercase"],
    [{ name: "rush__order" }, "single underscores"],
    [{ appliesTo: ["customer"] }, "body fields apply to"],
    [{ appliesTo: ["sale", "sale"] }, "duplicates"],
    [{ appliesTo: [] }, "appliesTo"],
    [{ type: "SELECT" }, "need selectRecordType"],
    [{ selectRecordType: "-2" }, "only for SELECT"],
    [{ type: "SELECT", selectRecordType: "customlist_x" }, "standard record type id"],
    [{ defaultChecked: true }, "only for CHECKBOX"],
    [{ type: "CHECKBOX", mandatory: true }, "cannot be mandatory"],
    [{ type: "PASSWORD" }, "type"],
    [{ type: "INLINEHTML" }, "type"],
    [{ extra: 1 }, "Unrecognized key"],
  ])("rejects %o", (patch, message) => {
    const spec = { kind: "body", name: "rush", label: "Rush", type: "TEXT", appliesTo: ["sale"], ...patch };
    expect(() => fieldArtifact(spec as never)).toThrow(SdfSpecError);
    expect(() => fieldArtifact(spec as never)).toThrow(message);
  });
});

describe("templateArtifact", () => {
  it("builds the object and the template file side by side", async () => {
    const a = templateArtifact({ record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source: INVOICE_SOURCE });
    expect(a.scriptId).toBe("custtmpl_nsagent_invoice_standard");
    expect(a.features).toEqual(["ACCOUNTING", "ADVANCEDPRINTING"]);
    expect(a.files.map((f) => f.path)).toEqual([
      "templates/custtmpl_nsagent_invoice_standard.xml",
      "templates/custtmpl_nsagent_invoice_standard.template.xml",
    ]);
    await expect(a.files[0]!.content).toMatchFileSnapshot("golden/custtmpl_nsagent_invoice_standard.xml");
    expect(a.files[1]!.content).toBe(`${INVOICE_SOURCE}\n`);
  });

  it("is never preferred", () => {
    const a = templateArtifact({ record: "salesorder", purpose: "pick", title: "Pick list", source: INVOICE_SOURCE });
    expect(a.files[0]!.content).toContain("<preferred>F</preferred>");
    expect(a.files[0]!.content).toContain('standard="STDTMPLSALESORD"');
    expect(() => templateArtifact({ record: "salesorder", purpose: "pick", title: "Pick list", source: INVOICE_SOURCE, preferred: true } as never)).toThrow(
      "Unrecognized key",
    );
  });

  it.each([
    [{ record: "customer" }, "record"],
    [{ purpose: "Standard" }, "lowercase"],
    [{ title: "x" }, "title"],
    [{ source: "<pdf></pdf>" }, "must start with <?xml"],
    [{ source: '<?xml version="1.0"?><pdf></pdf>' }, "DOCTYPE"],
    [{ source: INVOICE_SOURCE.replace("<#list", '<#include "x.ftl"><#list') }, "not allowed"],
    [{ source: INVOICE_SOURCE + " ".repeat(200_000) }, "source"],
  ])("rejects %o", (patch, message) => {
    const spec = { record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source: INVOICE_SOURCE, ...patch };
    expect(() => templateArtifact(spec as never)).toThrow(SdfSpecError);
    expect(() => templateArtifact(spec as never)).toThrow(message);
  });
});

describe("withRequiredFeatures", () => {
  const MANIFEST = `<manifest projecttype="ACCOUNTCUSTOMIZATION">
  <dependencies>
    <features>
      <feature required="true">SERVERSIDESCRIPTING</feature>
      <feature required="false">CRM</feature>
    </features>
  </dependencies>
</manifest>`;

  it("adds missing features and promotes optional ones", () => {
    expect(withRequiredFeatures(MANIFEST, ["CRM", "ADVANCEDPRINTING", "SERVERSIDESCRIPTING"])).toBe(`<manifest projecttype="ACCOUNTCUSTOMIZATION">
  <dependencies>
    <features>
      <feature required="true">SERVERSIDESCRIPTING</feature>
      <feature required="true">CRM</feature>
      <feature required="true">ADVANCEDPRINTING</feature>
    </features>
  </dependencies>
</manifest>`);
  });

  it("leaves a manifest that already has everything untouched", () => {
    expect(withRequiredFeatures(MANIFEST, ["SERVERSIDESCRIPTING"])).toBe(MANIFEST);
  });

  it("rejects bad input", () => {
    expect(() => withRequiredFeatures("<manifest/>", ["CRM"])).toThrow("no <features> block");
    expect(() => withRequiredFeatures(MANIFEST, ["crm</feature>"])).toThrow("invalid feature id");
  });
});
