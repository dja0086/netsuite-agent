/**
 * Shared governance helpers for ns_agent RESTlets.
 *
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 */
define(['N/runtime', 'N/error'], (runtime, error) => {
  /** Stop before NetSuite does, so the caller gets a clear, retryable error instead of SSS_USAGE_LIMIT_EXCEEDED. */
  const requireUsage = (minimumUnits) => {
    const remaining = runtime.getCurrentScript().getRemainingUsage();
    if (remaining < minimumUnits) {
      throw error.create({
        name: 'NS_AGENT_USAGE_LOW',
        message: `Only ${remaining} usage units left; narrow the request.`,
        notifyOff: true,
      });
    }
    return remaining;
  };

  const remainingUsage = () => runtime.getCurrentScript().getRemainingUsage();

  /** Rejects input that is missing or not a plain object. */
  const requireObject = (value, name) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw error.create({ name: 'NS_AGENT_BAD_INPUT', message: `${name} must be a JSON object`, notifyOff: true });
    }
    return value;
  };

  return { requireUsage, remainingUsage, requireObject };
});
