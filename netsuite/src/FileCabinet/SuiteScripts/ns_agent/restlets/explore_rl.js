/**
 * Read-only exploration RESTlet for the ns-agent gateway.
 * Actions:
 *   globalSearch { keywords, limit } -> NetSuite global search results (type, id, name, info)
 *
 * Deployed only to the ns-agent integration role (see customscript_ns_agent_explore_rl.xml).
 *
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 */
define(['N/search', 'N/error', '../lib/governance'], (search, error, governance) => {
  const MAX_RESULTS = 50;

  const fail = (name, message) => {
    throw error.create({ name, message, notifyOff: true });
  };

  const globalSearch = ({ keywords, limit }) => {
    if (typeof keywords !== 'string' || keywords.trim().length < 2 || keywords.length > 100) {
      fail('NS_AGENT_BAD_INPUT', 'keywords must be 2-100 characters');
    }
    const max = Math.min(Math.max(parseInt(limit, 10) || 20, 1), MAX_RESULTS);
    governance.requireUsage(50);

    const results = search.global({ keywords: keywords.trim() }).slice(0, max);
    return {
      keywords: keywords.trim(),
      count: results.length,
      results: results.map((r) => ({
        recordType: r.recordType,
        id: String(r.id),
        name: r.getValue({ name: 'name' }),
        type: r.getValue({ name: 'type' }),
        info1: r.getValue({ name: 'info1' }),
        info2: r.getValue({ name: 'info2' }),
      })),
      remainingUsage: governance.remainingUsage(),
    };
  };

  const ACTIONS = { globalSearch };

  const post = (body) => {
    governance.requireObject(body, 'request body');
    const handler = ACTIONS[body.action];
    if (!handler) fail('NS_AGENT_UNKNOWN_ACTION', `Unknown action: ${body.action}`);
    return handler(body);
  };

  return { post };
});
