import type { NsRequester } from "./http";

const SCRIPT_ID = /^customscript_[a-z0-9_]+$/;
const DEPLOY_ID = /^customdeploy_[a-z0-9_]+$/;

export interface RestletCall {
  scriptId: string;
  deployId: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Extra query parameters, used by GET handlers. */
  params?: Record<string, string | number | boolean>;
}

/** Calls a RESTlet deployed by this repo's SDF project. Only script IDs with the expected prefixes are allowed. */
export async function callRestlet<T = unknown>(ns: NsRequester, call: RestletCall): Promise<T> {
  if (!SCRIPT_ID.test(call.scriptId)) throw new Error(`Invalid RESTlet script id: ${call.scriptId}`);
  if (!DEPLOY_ID.test(call.deployId)) throw new Error(`Invalid RESTlet deployment id: ${call.deployId}`);
  return ns.request<T>({
    method: call.method ?? "POST",
    base: "restlet",
    path: "/app/site/hosting/restlet.nl",
    query: { ...call.params, script: call.scriptId, deploy: call.deployId },
    body: call.method === "GET" ? undefined : (call.body ?? {}),
  });
}
