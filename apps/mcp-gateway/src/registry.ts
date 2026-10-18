import type { MetadataCache, NsRequester } from "@ns-agent/ns-client";
import type { z } from "zod";

/** Everything a tool handler may use. Handlers never build their own NetSuite client. */
export interface ToolContext {
  ns: NsRequester;
  metadata: MetadataCache;
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  /** Read by the model to decide when to call the tool: say what it does, what it returns, and its limits. */
  description: string;
  /** Write tools change NetSuite data and always pass through the approval service. */
  writes: boolean;
  input: S;
  handler(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

/** Identity helper that keeps the handler's argument type tied to its input schema. */
export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Thrown by tools for errors the model should see and can act on (bad input, rejected query). */
export class ToolInputError extends Error {
  override readonly name = "ToolInputError";
}

/** Maximum rows any tool returns to the model in one call; larger results are paged or exported. */
export const MAX_ROWS_TO_MODEL = 200;
