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

  it("reads a RESTlet error whose message breaks the JSON (SuiteScriptError with bad escaping)", () => {
    // Shape seen from TSTDRV1755417: the inner message's quotes are escaped as \\", so JSON.parse fails.
    const body = String.raw`{"error" : {"code" : "WRONG_PARAMETER_TYPE", "message" : "{\"type\":\"error.SuiteScriptError\",\"name\":\"WRONG_PARAMETER_TYPE\",\"message\":\"Invalid sort; use \\"ASC\\", \\"DESC\\" or \\"NONE\\".\"}"}}`;
    expect(() => JSON.parse(body)).toThrow();
    const err = parseNsError(400, body);
    expect(err.code).toBe("WRONG_PARAMETER_TYPE");
    expect(err.message).toContain("Invalid sort");
    expect(err.message.length).toBeLessThanOrEqual(300);
  });

  it("reads the inner message when a stack array with raw newlines follows it", () => {
    // Shapes seen from the PDF preview RESTlet on TSTDRV1755417 (record.load and N/render errors), stack shortened.
    const missing =
      '{"type":"error.SuiteScriptError","name":"RCRD_DSNT_EXIST","message":"That record does not exist.","id":"999999999",' +
      '"stack":["Error\n    at suitescript/resources/javascript/record/recordImpl.js:96:12"],"cause":{"name":"RCRD_DSNT_EXIST"}}';
    expect(() => JSON.parse(missing)).toThrow();
    const err = parseNsError(400, JSON.stringify({ error: { code: "RCRD_DSNT_EXIST", message: missing } }));
    expect(err).toMatchObject({ code: "RCRD_DSNT_EXIST", message: "That record does not exist." });

    const xml = String.raw`{\"type\":\"error.SuiteScriptError\",\"name\":\"USER_ERROR\",\"message\":\"Error Parsing XML: The element type \\\"p\\\" must be terminated.\",\"id\":\"\",\"stack\":[\"Error\n    at preview\"]}`;
    const body = `{"error" : {"code" : "USER_ERROR", "message" : "${xml}"}}`;
    expect(parseNsError(400, body)).toMatchObject({ code: "USER_ERROR", message: 'Error Parsing XML: The element type "p" must be terminated.' });
  });

  it("uses the inner SuiteScriptError message when a RESTlet nests one", () => {
    const inner = JSON.stringify({ type: "error.SuiteScriptError", name: "NS_AGENT_BAD_INPUT", message: "unknown operator \"drop\"" });
    const err = parseNsError(400, JSON.stringify({ error: { code: "NS_AGENT_BAD_INPUT", message: inner } }));
    expect(err).toMatchObject({ code: "NS_AGENT_BAD_INPUT", message: 'unknown operator "drop"' });
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
