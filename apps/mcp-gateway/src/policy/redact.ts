export const REDACTED = "[REDACTED]";

/** Builds the set of field ids to mask from NS_AGENT_REDACT_FIELDS (comma separated, case-insensitive). */
export function redactFieldsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.NS_AGENT_REDACT_FIELDS ?? "")
      .split(",")
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Deep-copies `value`, replacing the value of any key in `fields` with [REDACTED]. Runs on every tool result. */
export function redact<T>(value: T, fields: ReadonlySet<string>): T {
  if (fields.size === 0) return value;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
        out[key] = fields.has(key.toLowerCase()) ? REDACTED : walk(child);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
