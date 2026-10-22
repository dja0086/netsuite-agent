/** One generated file, relative to netsuite/src/Objects/. */
export interface SdfFile {
  path: string;
  content: string;
}

/** What a spec turns into: the files to add and the manifest features they need. */
export interface SdfArtifact {
  scriptId: string;
  files: SdfFile[];
  /** Feature IDs the manifest should list as required (sorted, unique). */
  features: string[];
}

export class SdfSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SdfSpecError";
  }
}

export const esc = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const flag = (b: boolean) => (b ? "T" : "F");

/** Renders `<tag>value</tag>` lines in the given order; undefined values render as empty elements. */
export function elements(fields: [string, string | undefined][], indent = "  "): string {
  return fields.map(([tag, value]) => `${indent}<${tag}>${value === undefined ? "" : esc(value)}</${tag}>`).join("\n");
}

export const sortedUnique = (xs: Iterable<string>) => [...new Set(xs)].sort();
