/**
 * SuiteQL is read-only in NetSuite, so these guards are defense in depth: they keep agent-written
 * queries to a single SELECT and give the model a clear error instead of a NetSuite one.
 */

export class QueryRejectedError extends Error {
  override readonly name = "QueryRejectedError";
}

const MAX_QUERY_LENGTH = 20_000;
const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|COMMIT|ROLLBACK)\b/i;

/** Replaces string literals and comments with spaces so keyword checks only see SQL structure. */
export function maskLiteralsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'") {
      // String literal; '' is an escaped quote.
      out += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (ch === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Throws QueryRejectedError unless `q` is a single SELECT statement. Returns the trimmed query. */
export function assertSelectOnly(q: string): string {
  const query = q.trim().replace(/;\s*$/, "");
  if (!query) throw new QueryRejectedError("Query is empty");
  if (query.length > MAX_QUERY_LENGTH) throw new QueryRejectedError(`Query is longer than ${MAX_QUERY_LENGTH} characters`);

  const structure = maskLiteralsAndComments(query);
  if (structure.includes(";")) throw new QueryRejectedError("Only one statement is allowed");
  if (!/^\s*\(*\s*SELECT\b/i.test(structure)) {
    throw new QueryRejectedError("Only SELECT queries are allowed (SuiteQL does not support WITH/CTEs)");
  }
  const forbidden = FORBIDDEN.exec(structure);
  if (forbidden) throw new QueryRejectedError(`Keyword ${forbidden[1]!.toUpperCase()} is not allowed`);
  return query;
}

/** Quotes a string for use as a SuiteQL literal. Prefer this over string concatenation of user input. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Validates a SuiteQL identifier (table or column name) before it is placed into a query. */
export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new QueryRejectedError(`Invalid identifier: ${name}`);
  return name;
}
