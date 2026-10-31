import { z } from "zod";

/**
 * What the owner (and the drafting model) can decide about an agent. Everything else, such as the MCP
 * server, permission policies and networking, is fixed by rules.ts and has no field here on purpose.
 */
export const AgentSpec = z.object({
  name: z.string().min(3).max(80).describe("Short agent name, e.g. 'Weekly overdue clients'"),
  description: z.string().max(300).describe("One sentence: what the agent does and for whom"),
  instructions: z
    .string()
    .min(20)
    .max(8000)
    .describe("The agent's working instructions: the task, which records and fields, filters, output layout"),
  readTools: z.array(z.string()).describe("NetSuite read tools the agent may call without asking"),
  writeTools: z
    .array(z.string())
    .describe("NetSuite write tools the use case truly needs; each call will wait for the owner's approval. Usually empty."),
  outputFiles: z
    .array(z.enum(["xlsx", "pdf", "docx", "csv"]))
    .describe("File types the agent must produce; empty when it only answers in text"),
  kickoff: z.string().min(5).max(2000).describe("The message that starts one run of this agent"),
  openQuestions: z
    .array(z.string())
    .describe("Points the use case leaves unclear that the owner should settle before creating the agent"),
});
export type AgentSpec = z.infer<typeof AgentSpec>;
