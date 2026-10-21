/**
 * Saved-search RESTlet for the ns-agent gateway (search-builder skill).
 * Actions:
 *   preview { recordType, filters, columns, limit } -> total match count and the first rows. Read-only.
 *   save    { recordType, filters, columns, title, scriptId } -> creates a private saved search.
 *           The gateway calls this only after a named approver approved that exact payload (ADR 0004).
 *
 * Deployed only to the ns-agent integration role (see customscript_ns_agent_search_rl.xml).
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/error', '../lib/governance'], (search, error, governance) => {
  const MAX_ROWS = 50;
  const MAX_FILTERS = 20;
  const MAX_COLUMNS = 30;
  const IDENT = /^[a-z][a-z0-9_]*$/i;
  const SCRIPT_ID = /^customsearch_nsagent_[a-z0-9_]{3,30}$/;
  const OPERATORS = new Set(Object.values(search.Operator).map((o) => String(o).toLowerCase()));
  const SUMMARIES = new Set(['group', 'count', 'sum', 'avg', 'min', 'max']);

  const fail = (message) => {
    throw error.create({ name: 'NS_AGENT_BAD_INPUT', message, notifyOff: true });
  };

  const ident = (value, what) => {
    if (typeof value !== 'string' || !IDENT.test(value)) fail(`${what} must be a field or record id, got ${JSON.stringify(value)}`);
    return value;
  };

  const buildFilters = (filters) => {
    if (!Array.isArray(filters) || filters.length > MAX_FILTERS) fail(`filters must be an array of at most ${MAX_FILTERS}`);
    return filters.map((f) => {
      const operator = String(f && f.operator).toLowerCase();
      if (!OPERATORS.has(operator)) fail(`unknown operator ${JSON.stringify(f && f.operator)}`);
      const values = Array.isArray(f.values) ? f.values : [];
      if (values.length > 50 || values.some((v) => !['string', 'number', 'boolean'].includes(typeof v))) {
        fail('filter values must be at most 50 strings, numbers or booleans');
      }
      return search.createFilter({
        name: ident(f.field, 'filter field'),
        join: f.join ? ident(f.join, 'filter join') : undefined,
        operator,
        values,
      });
    });
  };

  const buildColumns = (columns) => {
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > MAX_COLUMNS) {
      fail(`columns must be an array of 1 to ${MAX_COLUMNS}`);
    }
    return columns.map((c) => {
      const summary = c.summary ? String(c.summary).toLowerCase() : undefined;
      if (summary && !SUMMARIES.has(summary)) fail(`unknown summary ${JSON.stringify(c.summary)}`);
      const sort = c.sort ? String(c.sort).toLowerCase() : undefined;
      if (sort && sort !== 'asc' && sort !== 'desc') fail('sort must be asc or desc');
      return search.createColumn({
        name: ident(c.field, 'column field'),
        join: c.join ? ident(c.join, 'column join') : undefined,
        summary: summary ? summary.toUpperCase() : undefined,
        sort: sort ? sort.toUpperCase() : undefined,
        label: typeof c.label === 'string' ? c.label.slice(0, 60) : undefined,
      });
    });
  };

  const columnKey = (c) => `${c.join ? `${c.join}.` : ''}${c.field}${c.summary ? `_${String(c.summary).toLowerCase()}` : ''}`;

  const build = (body) => {
    const type = ident(body.recordType, 'recordType');
    return { type, filters: buildFilters(body.filters || []), columns: buildColumns(body.columns) };
  };

  const preview = (body) => {
    governance.requireUsage(100);
    const { type, filters, columns } = build(body);
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 20, 1), MAX_ROWS);
    const s = search.create({ type, filters, columns });
    const totalCount = s.runPaged({ pageSize: 50 }).count;
    const keys = body.columns.map(columnKey);
    const rows = s
      .run()
      .getRange({ start: 0, end: limit })
      .map((r) => {
        const row = {};
        columns.forEach((col, i) => {
          const value = r.getValue(col);
          const text = r.getText(col);
          row[keys[i]] = text && text !== value ? { value, text } : value;
        });
        return row;
      });
    return { recordType: type, totalCount, columns: keys, rows, remainingUsage: governance.remainingUsage() };
  };

  const save = (body) => {
    governance.requireUsage(100);
    const { type, filters, columns } = build(body);
    if (typeof body.scriptId !== 'string' || !SCRIPT_ID.test(body.scriptId)) fail('scriptId must match customsearch_nsagent_<3-30 of a-z0-9_>');
    if (typeof body.title !== 'string' || body.title.trim().length < 3 || body.title.length > 100) fail('title must be 3-100 characters');
    let exists = false;
    try {
      search.load({ id: body.scriptId });
      exists = true;
    } catch (e) {
      exists = false;
    }
    if (exists) throw error.create({ name: 'NS_AGENT_EXISTS', message: `${body.scriptId} already exists`, notifyOff: true });
    const s = search.create({ type, filters, columns, title: body.title.trim(), id: body.scriptId, isPublic: false });
    const internalId = s.save();
    return { saved: true, internalId: String(internalId), scriptId: body.scriptId, title: body.title.trim() };
  };

  const ACTIONS = { preview, save };

  const post = (body) => {
    governance.requireObject(body, 'request body');
    const handler = ACTIONS[body.action];
    if (!handler) throw error.create({ name: 'NS_AGENT_UNKNOWN_ACTION', message: `Unknown action: ${body.action}`, notifyOff: true });
    return handler(body);
  };

  return { post };
});
