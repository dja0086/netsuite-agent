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

const stripComments = (source: string) => source.replace(/<#--[\s\S]*?-->/g, " ").replace(/\[#--[\s\S]*?--\]/g, " ");

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

/**
 * Problems with an Advanced PDF/HTML template source that make it unsafe to render or deploy, beyond its shape:
 * pulling in other files, building code at render time, or loading a resource from an address built from record data
 * or outside NetSuite (BFO fetches images, fonts and stylesheets while rendering, which would send data out of
 * NetSuite). Used by the template spec; the PDF preview path must apply it too before rendering a draft.
 *
 * This is a pattern check, not a FreeMarker parser: a template that assembles a URL from string pieces can still get
 * past it, so the rule that templates reach production only through PR review stays in force.
 */
export function templateSourceIssues(source: string): string[] {
  const issues: string[] = [];
  const src = stripComments(source);
  if (/[<[]#(include|import)\b/.test(src)) issues.push("<#include> and <#import> are not allowed (in either bracket syntax)");
  if (/\?\s*(interpret|eval|new)\b/.test(src)) issues.push("the ?interpret, ?eval and ?new built-ins are not allowed");
  if (/@import\b/i.test(src)) issues.push("CSS @import is not allowed");
  for (const raw of resourceValues(src, issues)) {
    const value = raw.trim();
    if (SAFE_EXPRESSION.test(value)) continue;
    if (FREEMARKER.test(value)) {
      issues.push(`FreeMarker inside a src, href or url() value is not allowed (${value.slice(0, 60)}): the renderer would fetch that address`);
    }
    if (/^(file|ftp):/i.test(value)) issues.push(`file: and ftp: addresses are not allowed (${value.slice(0, 60)})`);
    const relativeHost = /^\/\/([A-Za-z0-9.-]+)/.exec(value)?.[1];
    if (relativeHost && !ALLOWED_HOST.test(relativeHost)) issues.push(`only NetSuite addresses may be referenced, found ${relativeHost}`);
  }
  // Any literal http(s) address anywhere (attribute, string, style) must be NetSuite's own.
  for (const m of src.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)/gi)) {
    if (!ALLOWED_HOST.test(m[1]!)) issues.push(`only NetSuite addresses may be referenced, found ${m[1]}`);
  }
  return [...new Set(issues)];
}
