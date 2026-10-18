import type { ToolDef } from "../registry";
import { dataTools } from "./data";
// new-skill:imports (pnpm new:skill adds tool module imports above this line)

/**
 * Every tool the gateway can expose. A tool is only served when an enabled skill declares it,
 * and `pnpm skills:validate` fails when a skill declares a tool missing from this list.
 */
export const ALL_TOOLS: ToolDef[] = [
  ...(dataTools as unknown as ToolDef[]),
  // new-skill:tools (pnpm new:skill adds tool lists above this line)
];

export function toolByName(name: string): ToolDef | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}
