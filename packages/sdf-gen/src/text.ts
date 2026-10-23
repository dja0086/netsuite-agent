import { z } from "zod";

// XML 1.0 forbids these (C0 controls other than tab/newline/carriage return, and U+FFFE/U+FFFF); a file containing
// one does not parse.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

/** Free text written into an XML element (description, title). */
export const plainText = (max: number) => z.string().max(max).refine((s) => !CONTROL.test(s), "control characters are not allowed");

/**
 * Label and help text. SDF treats these as references to translation strings, so a value starting with "[" (as in
 * [scriptid=...]) would be read as a reference instead of text.
 */
export const formText = (max: number) =>
  plainText(max).refine((s) => !s.trimStart().startsWith("["), 'text must not start with "[" (SDF reads it as a reference)');

/** FreeMarker syntax that can produce text at render time. */
const FREEMARKER = /\$\{|#\{|<#|<@|\[#|\[@/;
/** Whole-value expressions standard NetSuite templates use for NetSuite-hosted resources. */
const SAFE_EXPRESSION = /^\$\{(nsfont\.[A-Za-z0-9_]+|companyInformation\.logoUrl)\}$/;
/** Hosts a template may load resources from: NetSuite's own (fonts, media, company logo). */
const ALLOWED_HOST = /(^|\.)netsuite\.com$/i;

/** Comments removed entirely, so text split by a comment (s<#-- -->rc) reads joined, as FreeMarker outputs it. */
const stripComments = (source: string) => source.replace(/<#--[\s\S]*?-->/g, "").replace(/\[#--[\s\S]*?--\]/g, "");

/** XML character references and the five named entities decoded, as the XML parser does before BFO sees a value. */
const decodeEntities = (source: string) =>
  source
    .replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#([0-9]+);?/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&(lt|gt|quot|apos|amp);/g, (_, n: string) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[n]!);

/**
 * The host an absolute or protocol-relative address points at, or an issue when it cannot be trusted. Userinfo
 * (x.netsuite.com@evil.example) is refused outright: URL parsers take the host after the "@".
 */
function hostIssue(address: string): string | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#\s"'<>)\\]*)/i.exec(address.trim());
  if (!m) return undefined;
  const authority = m[1]!;
  if (authority.includes("@")) return `addresses with a user part are not allowed (${authority.slice(0, 60)})`;
  const host = authority.replace(/:[0-9]*$/, "").toLowerCase();
  return ALLOWED_HOST.test(host) ? undefined : `only NetSuite addresses may be referenced, found ${host || "(empty host)"}`;
}

/** Values of src/href attributes and CSS url(...) references, or an issue when one is not a plain quoted value. */
function resourceValues(source: string, issues: string[]): string[] {
  const values: string[] = [];
  for (const m of source.matchAll(/\b(src|href)\s*=\s*/gi)) {
    const start = m.index! + m[0].length;
    const quote = source[start];
    if (quote !== '"' && quote !== "'") {
      issues.push(`${m[1]} must be a quoted value`);
      continue;
    }
    const end = source.indexOf(quote, start + 1);
    values.push(end < 0 ? source.slice(start + 1) : source.slice(start + 1, end));
  }
  for (const m of source.matchAll(/url\(\s*([^)]*)\)/gi)) values.push(m[1]!.trim().replace(/^["']|["']$/g, ""));
  return values;
}

function scan(src: string, issues: string[]): void {
  if (/[<[]#(include|import)\b/.test(src)) issues.push("<#include> and <#import> are not allowed (in either bracket syntax)");
  if (/\?\s*(interpret|eval|new)\b/.test(src)) issues.push("the ?interpret, ?eval and ?new built-ins are not allowed");
  if (/@import\b/i.test(src)) issues.push("CSS @import is not allowed");
  for (const raw of resourceValues(src, issues)) {
    const value = raw.trim();
    if (SAFE_EXPRESSION.test(value)) continue;
    if (FREEMARKER.test(value)) {
      issues.push(`FreeMarker inside a src, href or url() value is not allowed (${value.slice(0, 60)}): the renderer would fetch that address`);
    }
    if (/^(file|ftp|jar):/i.test(value)) issues.push(`file:, ftp: and jar: addresses are not allowed (${value.slice(0, 60)})`);
    const host = hostIssue(value);
    if (host) issues.push(host);
  }
  // Any literal absolute address anywhere (attribute, string, style) must be NetSuite's own.
  for (const m of src.matchAll(/\bhttps?:\/\/[^\s"'<>)]*/gi)) {
    const host = hostIssue(m[0]);
    if (host) issues.push(host);
  }
}

/**
 * A LINT for Advanced PDF/HTML template sources, not a security boundary. It flags the patterns that usually mean
 * trouble: pulling in other files, building code at render time, or loading a resource from an address built from
 * record data or outside NetSuite (BFO fetches images, fonts and stylesheets while rendering).
 *
 * FreeMarker can build any text at render time (shadowing a variable, assembling an attribute from pieces), so no
 * check of the source can prove a template safe; three review rounds found new bypasses each time. The controls are:
 * - deployed templates: pull request review (change-control), where the reviewer reads every src, href and url();
 * - previews: pdf_rl.js renders the template to markup first and checks the rendered resource addresses before
 *   making a PDF.
 *
 * Each check runs on the source as written, with comments removed, and with XML entities decoded, so hiding a
 * pattern behind one of those does not hide it from all three.
 */
export function templateSourceIssues(source: string): string[] {
  const issues: string[] = [];
  const views = [source, stripComments(source)];
  for (const view of [...views, ...views.map(decodeEntities)]) scan(view, issues);
  return [...new Set(issues)];
}

/**
 * What a reviewer must read in a template (change-control): every src, href and url() value, and every variable the
 * template assigns (an assignment can shadow a NetSuite variable such as nsfont). A pointer list, not a verdict.
 */
export function templateReviewPoints(source: string): { resources: string[]; assignments: string[] } {
  const resources = resourceValues(decodeEntities(source), []).map((v) => v.trim());
  const assignments = [...source.matchAll(/[<[]#(?:assign|global|local)\s+([A-Za-z_][\w.]*)/g)].map((m) => m[1]!);
  return { resources: [...new Set(resources)], assignments: [...new Set(assignments)] };
}
