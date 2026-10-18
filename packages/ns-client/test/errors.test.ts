import { describe, expect, it } from "vitest";
import { NsHttpError, isThrottle, parseNsError } from "../src";

describe("parseNsError", () => {
  it("reads the REST web services error shape", () => {
    const err = parseNsError(
      400,
      JSON.stringify({
        title: "Bad Request",
        status: 400,
        "o:errorDetails": [{ detail: "Invalid search query.", "o:errorCode": "INVALID_PARAMETER" }],
      }),
    );
    expect(err).toMatchObject({ status: 400, code: "INVALID_PARAMETER", message: "Invalid search query." });
  });

  it("reads the RESTlet error shape", () => {
    const err = parseNsError(400, JSON.stringify({ error: { code: "SSS_REQUEST_LIMIT_EXCEEDED", message: "limit" } }));
    expect(err.code).toBe("SSS_REQUEST_LIMIT_EXCEEDED");
    expect(isThrottle(err)).toBe(true);
  });

  it("finds a throttle code in a non-JSON body", () => {
    expect(parseNsError(400, "<html>SSS_REQUEST_LIMIT_EXCEEDED</html>").code).toBe("SSS_REQUEST_LIMIT_EXCEEDED");
  });
});

describe("isThrottle", () => {
  it("is true for HTTP 429", () => expect(isThrottle(new NsHttpError(429, undefined, "x"))).toBe(true));
  it("is false for other errors", () => {
    expect(isThrottle(new NsHttpError(500, undefined, "x"))).toBe(false);
    expect(isThrottle(new Error("x"))).toBe(false);
  });
});
