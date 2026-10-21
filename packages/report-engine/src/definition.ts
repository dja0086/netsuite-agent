import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { QueryRejectedError, assertSelectOnly, maskLiteralsAndComments } from "@ns-agent/suiteql";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const NAME = /^[a-z][a-z0-9_]*$/;

export const ReportParam = z
  .object({
    name: z.string().regex(NAME, "param names are lowercase snake_case"),
    type: z.enum(["date", "string", "number", "id", "idList"]),
    required: z.boolean().default(false),
    /** A literal default, or "today" for date params. */
    default: z.union([z.string(), z.number()]).optional(),
    description: z.string().optional(),
  })
  .strict();
export type ReportParam = z.infer<typeof ReportParam>;

export const ReportColumn = z
  .object({
    key: z.string().regex(NAME, "column keys are the query's lowercase aliases"),
    label: z.string().min(1).max(60),
    type: z.enum(["text", "integer", "number", "currency", "date"]).default("text"),
  })
  .strict();
export type ReportColumn = z.infer<typeof ReportColumn>;

/** Placeholders (:name) outside string literals and comments. */
export function placeholders(query: string): string[] {
  const masked = maskLiteralsAndComments(query.replace(/\{\{[#/][a-z0-9_]+\}\}/g, " "));
  return [...new Set([...masked.matchAll(/(?<![:\w]):([a-z][a-z0-9_]*)\b/g)].map((m) => m[1]!))];
}

export const ReportDefinition = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/, "report ids are kebab-case"),
    title: z.string().min(3).max(80),
    description: z.string().min(10),
    params: z.array(ReportParam).default([]),
    /** SuiteQL SELECT with :param placeholders; {{#p}}...{{/p}} sections are dropped when p has no value. */
    query: z.string().min(8),
    columns: z.array(ReportColumn).min(1),
    /** Hard cap on rows written to the file. */
    maxRows: z.number().int().min(1).max(100_000).default(50_000),
  })
  .strict()
  .superRefine((d, ctx) => {
    try {
      assertSelectOnly(d.query.replace(/\{\{[#/][a-z0-9_]+\}\}/g, " "));
    } catch (e) {
      if (e instanceof QueryRejectedError) ctx.addIssue({ code: "custom", path: ["query"], message: e.message });
    }
    const declared = new Set(d.params.map((p) => p.name));
    for (const name of placeholders(d.query)) {
      if (!declared.has(name)) ctx.addIssue({ code: "custom", path: ["query"], message: `placeholder :${name} is not a declared param` });
    }
    for (const m of d.query.matchAll(/\{\{#([a-z0-9_]+)\}\}/g)) {
      if (!declared.has(m[1]!)) ctx.addIssue({ code: "custom", path: ["query"], message: `section {{#${m[1]}}} is not a declared param` });
    }
  });
export type ReportDefinition = z.infer<typeof ReportDefinition>;

/** Loads every *.yaml definition in a folder; the file name must match the report id. */
export async function loadDefinitions(dir: string): Promise<ReportDefinition[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  const defs: ReportDefinition[] = [];
  for (const file of files) {
    const parsed = ReportDefinition.safeParse(parseYaml(await readFile(path.join(dir, file), "utf8")));
    if (!parsed.success) {
      throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (`${parsed.data.id}.yaml` !== file) throw new Error(`${file}: id ${parsed.data.id} must match the file name`);
    defs.push(parsed.data);
  }
  return defs;
}
