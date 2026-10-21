import { z } from "zod";

export const TOOL_NAME = /^ns_[a-z][a-z0-9_]*$/;
export const SKILL_NAME = /^[a-z][a-z0-9-]{1,62}$/;
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Frontmatter of every skills/<name>/SKILL.md. The agent host reads name + description; the gateway and CI read the rest. */
export const SkillManifest = z
  .object({
    name: z.string().regex(SKILL_NAME, "kebab-case, 2-63 characters"),
    description: z.string().min(40, "say what the skill does AND when to use it").max(1024),
    version: z.string().regex(SEMVER, "semver, e.g. 1.0.0"),
    owner: z.string().min(1),
    tools: z.array(z.string().regex(TOOL_NAME, "tool names start with ns_")).default([]),
    writes: z.boolean(),
    enabled: z.boolean().default(true),
    platform: z.boolean().default(false),
    deprecated: z.boolean().default(false),
    replacement: z.string().regex(SKILL_NAME).optional(),
    governance_budget: z.object({
      max_calls_per_invocation: z.number().int().positive(),
      max_concurrency: z.number().int().positive().max(20),
    }),
  })
  .strict()
  .superRefine((m, ctx) => {
    if (m.deprecated && !m.replacement) {
      ctx.addIssue({ code: "custom", path: ["replacement"], message: "a deprecated skill must name its replacement" });
    }
    // A skill under construction ships with enabled: false and may not have tools yet.
    if (!m.platform && m.enabled && m.tools.length === 0) {
      ctx.addIssue({ code: "custom", path: ["tools"], message: "an enabled user-facing skill must declare at least one tool" });
    }
  });
export type SkillManifest = z.infer<typeof SkillManifest>;

/** skills/<name>/evals/triggers.yaml: prompts that should and should not route to the skill. */
export const TriggerEvals = z
  .object({
    should_route: z.array(z.string().min(5)).min(5, "at least 5 prompts that should route here"),
    should_not_route: z.array(z.string().min(5)).min(3, "at least 3 prompts that belong to other skills"),
  })
  .strict();
export type TriggerEvals = z.infer<typeof TriggerEvals>;

export const ToolExpectation = z
  .object({
    ok: z.boolean().default(true),
    min_rows: z.number().int().nonnegative().optional(),
    max_rows: z.number().int().nonnegative().optional(),
    has_keys: z.array(z.string()).optional(),
    error_contains: z.string().optional(),
  })
  .strict();

/**
 * skills/<name>/evals/tasks.yaml.
 *  - kind "tool": deterministic call of one gateway tool against the sandbox (run by `pnpm skills:eval --mode tools`)
 *  - kind "agent": a full prompt judged by the agent-host adapter ([FILL: agent host for agent evals])
 */
export const TaskCase = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tool"),
      id: z.string().min(1),
      description: z.string().optional(),
      tool: z.string().regex(TOOL_NAME),
      input: z.record(z.string(), z.unknown()).default({}),
      expect: ToolExpectation,
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent"),
      id: z.string().min(1),
      prompt: z.string().min(5),
      // Empty when the right answer needs no tool; the rubric still judges it.
      expect_tools: z.array(z.string().regex(TOOL_NAME)).default([]),
      forbid_tools: z.array(z.string().regex(TOOL_NAME)).default([]),
      rubric: z.string().min(10),
    })
    .strict(),
]);
export type TaskCase = z.infer<typeof TaskCase>;

export const TaskEvals = z
  .object({
    cases: z.array(TaskCase).min(3, "at least 3 task cases"),
  })
  .strict();
export type TaskEvals = z.infer<typeof TaskEvals>;
