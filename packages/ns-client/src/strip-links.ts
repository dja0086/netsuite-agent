/** Removes NetSuite's HATEOAS "links" arrays, which add noise and tokens without adding data. */
export function stripLinks<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripLinks) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "links") continue;
      out[key] = stripLinks(child);
    }
    return out as T;
  }
  return value;
}
