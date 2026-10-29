/**
 * Input guards for the ns_agent custom tools (tools/agent_tools.js). The same rules as the gateway's
 * packages/suiteql guards: one SELECT statement, no write keywords, plain identifiers, capped rows. SuiteQL is
 * read-only anyway; these give the AI client a clear error instead of a NetSuite one. No NetSuite modules, so it
 * can be unit-tested outside NetSuite.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define([], () => {
  const MAX_QUERY_LENGTH = 20000;
  /** Rows a tool returns to the AI client, as the gateway's MAX_ROWS_TO_MODEL. */
  const MAX_ROWS = 200;
  const DEFAULT_ROWS = 50;
  const MAX_FIELDS = 50;
  const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXEC|EXECUTE|CALL|COMMIT|ROLLBACK)\b/i;
  const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

  class ToolInputError extends Error {
    constructor(message) {
      super(message);
      this.name = 'ToolInputError';
    }
  }

  /** Replaces string literals and comments with spaces so keyword checks only see SQL structure. */
  const maskLiteralsAndComments = (sql) => {
    let out = '';
    let i = 0;
    while (i < sql.length) {
      const ch = sql[i];
      const next = sql[i + 1];
      if (ch === "'") {
        // String literal; '' is an escaped quote.
        out += ' ';
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
        out += ' ';
        continue;
      }
      if (ch === '-' && next === '-') {
        while (i < sql.length && sql[i] !== '\n') i++;
        out += ' ';
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = sql.indexOf('*/', i + 2);
        i = end === -1 ? sql.length : end + 2;
        out += ' ';
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  };

  /** The trimmed query, or a ToolInputError unless it is a single SELECT statement. */
  const assertSelectOnly = (q) => {
    if (typeof q !== 'string') throw new ToolInputError('query must be a string');
    const query = q.trim().replace(/;\s*$/, '');
    if (!query) throw new ToolInputError('Query is empty');
    if (query.length > MAX_QUERY_LENGTH) throw new ToolInputError(`Query is longer than ${MAX_QUERY_LENGTH} characters`);
    const structure = maskLiteralsAndComments(query);
    if (structure.includes(';')) throw new ToolInputError('Only one statement is allowed');
    if (!/^\s*\(*\s*SELECT\b/i.test(structure)) {
      throw new ToolInputError('Only SELECT queries are allowed (SuiteQL does not support WITH/CTEs)');
    }
    const forbidden = FORBIDDEN.exec(structure);
    if (forbidden) throw new ToolInputError(`Keyword ${forbidden[1].toUpperCase()} is not allowed`);
    return query;
  };

  /** Rows to return: 1..MAX_ROWS, DEFAULT_ROWS when absent. */
  const rowLimit = (value) => {
    if (value === undefined || value === null || value === '') return DEFAULT_ROWS;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_ROWS) throw new ToolInputError(`limit must be a whole number from 1 to ${MAX_ROWS}`);
    return n;
  };

  const identifier = (name, what) => {
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) throw new ToolInputError(`${what} must be a plain identifier such as customer or companyname`);
    return name;
  };

  /** A positive internal id. */
  const recordId = (value) => {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string' || !/^[1-9][0-9]{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw new ToolInputError('id must be a positive internal id');
    }
    return Number(text);
  };

  /** "id, companyname, email" -> ['id', 'companyname', 'email']; at most MAX_FIELDS plain identifiers. */
  const fieldList = (value) => {
    if (typeof value !== 'string' || !value.trim()) throw new ToolInputError('fields must list at least one field, separated by commas');
    const fields = value.split(',').map((f) => f.trim()).filter(Boolean);
    if (fields.length > MAX_FIELDS) throw new ToolInputError(`fields lists more than ${MAX_FIELDS} fields`);
    return [...new Set(fields.map((f) => identifier(f, 'each field').toLowerCase()))];
  };

  return { ToolInputError, MAX_ROWS, DEFAULT_ROWS, maskLiteralsAndComments, assertSelectOnly, rowLimit, identifier, recordId, fieldList };
});
