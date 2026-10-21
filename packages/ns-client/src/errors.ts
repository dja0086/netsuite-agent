/** Error raised for any non-2xx NetSuite response. The body is kept for diagnostics but never logged by default. */
export class NsHttpError extends Error {
  override readonly name = "NsHttpError";

  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body?: string,
  ) {
    super(message);
  }
}

/** Error codes NetSuite uses when a request is rejected for concurrency or request-rate reasons. */
const THROTTLE_CODES = new Set([
  "SSS_REQUEST_LIMIT_EXCEEDED", // RESTlets (HTTP 400)
  "CONCURRENCY_LIMIT_EXCEEDED", // REST web services
  "REQUEST_LIMIT_EXCEEDED",
]);

const MAX_MESSAGE = 300;

/**
 * RESTlet errors often carry a serialized SuiteScriptError as their message ({"type":...,"name":...,"message":...}),
 * sometimes with broken escaping. Returns the human part, capped.
 */
function innerMessage(raw: string): string {
  let message = raw;
  if (raw.trimStart().startsWith("{")) {
    try {
      const inner = JSON.parse(raw) as { message?: unknown };
      if (typeof inner.message === "string") message = inner.message;
    } catch {
      const flat = raw.replace(/\\+"/g, '"');
      const m = /"message"\s*:\s*"([\s\S]*)"\s*\}\s*$/.exec(flat);
      if (m) message = m[1]!;
    }
  }
  return message.slice(0, MAX_MESSAGE);
}

/**
 * Turns a NetSuite error response into an NsHttpError.
 * Handles the REST web services shape ({"o:errorDetails":[{"o:errorCode":...}]})
 * and the RESTlet shape ({"error":{"code":...,"message":...}}).
 */
export function parseNsError(status: number, text: string): NsHttpError {
  let code: string | undefined;
  let message = `NetSuite request failed with HTTP ${status}`;

  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const details = json["o:errorDetails"];
    if (Array.isArray(details) && details.length > 0) {
      const first = details[0] as Record<string, unknown>;
      code = typeof first["o:errorCode"] === "string" ? first["o:errorCode"] : undefined;
      if (typeof first.detail === "string") message = first.detail;
    } else if (json.error && typeof json.error === "object") {
      const err = json.error as Record<string, unknown>;
      code = typeof err.code === "string" ? err.code : undefined;
      if (typeof err.message === "string") message = innerMessage(err.message);
    } else if (typeof json.title === "string") {
      message = json.title;
    }
  } catch {
    // RESTlet errors whose message breaks the JSON: read the code and message fields directly.
    const restlet = /^\s*\{\s*"error"\s*:\s*\{\s*"code"\s*:\s*"([A-Za-z0-9_.]+)"\s*,\s*"message"\s*:\s*"([\s\S]*)"\s*\}\s*\}\s*$/.exec(text);
    if (restlet) {
      code = restlet[1];
      message = innerMessage(restlet[2]!);
    } else {
      // Non-JSON body (HTML error page, empty body). Fall back to a regex for known codes.
      const match = /\b(SSS_REQUEST_LIMIT_EXCEEDED|CONCURRENCY_LIMIT_EXCEEDED|REQUEST_LIMIT_EXCEEDED)\b/.exec(text);
      code = match?.[1];
    }
  }

  return new NsHttpError(status, code, message, text);
}

/** True when the error is a NetSuite throttling rejection that is safe to retry after a backoff. */
export function isThrottle(error: unknown): boolean {
  if (!(error instanceof NsHttpError)) return false;
  if (error.status === 429) return true;
  return error.code !== undefined && THROTTLE_CODES.has(error.code);
}
