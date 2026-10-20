/**
 * Makes recorded NetSuite responses safe to commit: keeps structure, keys, numbers, booleans and
 * structural strings (type codes, field ids, schema types), replaces everything else with "<string>".
 */
const KEEP_KEYS = new Set([
  "type",
  "format",
  "title",
  "name",
  "rel",
  "o:errorCode",
  "detail",
  "status",
  "mainline",
  "$ref",
  "x-ns-recordType",
]);

const SAFE_STRING = /^[A-Za-z][A-Za-z0-9_:.-]{0,60}$/;

export function sanitize(value: unknown, accountHost?: string, key?: string): unknown {
  if (Array.isArray(value)) return value.map((v) => sanitize(v, accountHost, key));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = sanitize(v, accountHost, k);
    return out;
  }
  if (typeof value !== "string") return value;

  let s = value;
  if (accountHost) s = s.split(accountHost).join("ACCOUNT");
  if (/https?:\/\//.test(s)) return s.replace(/https?:\/\/[^\s"]+/g, "https://ACCOUNT.example/…");
  if (key && KEEP_KEYS.has(key) && !s.includes("@")) return s;
  // Internal ids and other short identifiers carry no customer data.
  if (/^\d{1,12}$/.test(s)) return s;
  if (key === undefined && SAFE_STRING.test(s)) return s;
  return "<string>";
}
