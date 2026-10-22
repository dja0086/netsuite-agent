import { SdfSpecError } from "./xml";

const FEATURE_ID = /^[A-Z][A-Z0-9_]*$/;

/**
 * Returns the manifest with each feature listed as required: optional entries are promoted, missing
 * ones are added before </features>. Everything else in the file is left as it was.
 */
export function withRequiredFeatures(manifestXml: string, features: readonly string[]): string {
  const close = manifestXml.match(/^([ \t]*)<\/features>/m);
  if (!close) throw new SdfSpecError("manifest has no <features> block");
  let xml = manifestXml;
  const indent = `${close[1]}  `;
  for (const f of features) {
    if (!FEATURE_ID.test(f)) throw new SdfSpecError(`invalid feature id: ${f}`);
    const entry = new RegExp(`<feature required="(true|false)">${f}</feature>`);
    const found = xml.match(entry);
    if (found?.[1] === "true") continue;
    xml = found
      ? xml.replace(entry, `<feature required="true">${f}</feature>`)
      : xml.replace(/^([ \t]*)<\/features>/m, `${indent}<feature required="true">${f}</feature>\n$1</features>`);
  }
  return xml;
}
