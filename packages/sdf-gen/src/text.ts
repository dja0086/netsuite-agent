import { z } from "zod";

// XML 1.0 forbids these; a file containing one does not parse.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

/** Free text written into an XML element (description, title). */
export const plainText = (max: number) => z.string().max(max).refine((s) => !CONTROL.test(s), "control characters are not allowed");

/**
 * Label and help text. SDF treats these as references to translation strings, so a value starting with "[" (as in
 * [scriptid=...]) would be read as a reference instead of text.
 */
export const formText = (max: number) =>
  plainText(max).refine((s) => !s.trimStart().startsWith("["), 'text must not start with "[" (SDF reads it as a reference)');

/**
 * Problems with an Advanced PDF/HTML template source that make it unsafe to render or deploy, beyond its shape:
 * pulling in other files, building code at render time, or putting record data into a URL the renderer fetches
 * (which would send it outside NetSuite). Shared by the template spec and the PDF preview path.
 */
export function templateSourceIssues(source: string): string[] {
  const issues: string[] = [];
  if (/[<[]#(include|import)\b/.test(source)) issues.push("<#include> and <#import> are not allowed (in either bracket syntax)");
  if (/\?\s*(interpret|eval|new)\b/.test(source)) issues.push("the ?interpret, ?eval and ?new built-ins are not allowed");
  if (/\b(src|href)\s*=\s*(["'])[^"']*\$\{/i.test(source) || /url\(\s*["']?[^)]*\$\{/i.test(source)) {
    issues.push("${...} inside a src, href or url() value is not allowed: the renderer would send record data to that address");
  }
  return issues;
}
