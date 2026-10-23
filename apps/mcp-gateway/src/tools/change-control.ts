import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { templateReviewPoints } from "@ns-agent/sdf-gen";
import { z } from "zod";
import { ToolInputError, defineTool, type ToolDef } from "../registry";
import { projectRoot } from "./sdf-project";

/** The only repository and GitHub account a change PR may go to (owner decision: the local gh login, dja0086). */
export const CHANGE_REPO = "dja0086/netsuite-agent";
export const CHANGE_GH_ACCOUNT = "dja0086";
const BASE = "main";
const ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)dja0086\/netsuite-agent(?:\.git)?\/?$/;
/** Objects the generate tools write: nsagent fields (ns_field_generate) and templates (ns_pdf_template_generate). */
const SCRIPT_ID = /^(custbody|custentity|custitem|custtmpl)_nsagent_[a-z0-9_]+$/;
const SDF_SRC = "netsuite/src";
const MANIFEST = `${SDF_SRC}/manifest.xml`;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

export class CommandError extends Error {
  override readonly name = "CommandError";
}

/** Runs git and gh without a shell. Tests replace `run` to fake the network side (fetch, push, the GitHub API). */
export const commands = {
  run(cmd: "git" | "gh", args: string[], opts: { cwd: string; env?: Record<string, string>; input?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", ...opts.env },
        // stdin only when there is input: writing to a child that exits without reading it raises EPIPE.
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeout: 120_000,
      });
      let out = "";
      let err = "";
      child.stdout!.on("data", (d) => (out += d));
      child.stderr!.on("data", (d) => (err += d));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out) : reject(new CommandError(`${cmd} ${args[0]} failed: ${err.trim().slice(0, 300)}`)),
      );
      if (child.stdin) {
        child.stdin.on("error", reject);
        child.stdin.end(opts.input);
      }
    });
  },
};

/** Repo-relative files an object consists of. */
function objectFiles(scriptId: string): string[] {
  if (scriptId.startsWith("custtmpl_")) {
    return [`${SDF_SRC}/Objects/templates/${scriptId}.xml`, `${SDF_SRC}/Objects/templates/${scriptId}.template.xml`];
  }
  return [`${SDF_SRC}/Objects/fields/${scriptId}.xml`];
}

/** Entries of `git status --porcelain=v1 -z`: two status letters and the path (a rename's source path is skipped). */
function parseStatus(raw: string): { xy: string; file: string }[] {
  const parts = raw.split("\0");
  const entries: { xy: string; file: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    entries.push({ xy, file: p.slice(3) });
    if (/[RC]/.test(xy)) i++;
  }
  return entries;
}

const features = (manifest: string) => new Set([...manifest.matchAll(/<feature required="true">([A-Z0-9_]+)<\/feature>/g)].map((m) => m[1]!));

/** Values shown inside a fenced block in the PR body; a fence inside a value would end the block. */
const fenced = (lines: string[]) => ["~~~text", ...lines.map((l) => l.replaceAll("~~~", "~ ~ ~")), "~~~"].join("\n");

interface TemplateReview {
  scriptId: string;
  file: string;
  resources: string[];
  assignments: string[];
}

/** The PR body: what changes, and what the reviewer checks before approving (change-control skill, step 3). */
function prBody(o: {
  summary: string;
  notes?: string;
  scriptIds: string[];
  files: string[];
  featuresAdded: string[];
  templates: TemplateReview[];
}): string {
  const fields = o.scriptIds.filter((id) => !id.startsWith("custtmpl_"));
  const out: string[] = [
    "## What this changes",
    "",
    o.summary,
    "",
    "| Object | Kind |",
    "| --- | --- |",
    ...o.scriptIds.map((id) => `| \`${id}\` | ${id.startsWith("custtmpl_") ? "Advanced PDF/HTML template (`advancedpdftemplate`)" : "custom field"} |`),
    "",
    `Files: ${o.files.map((f) => `\`${f}\``).join(", ")}.`,
    o.featuresAdded.length ? `manifest.xml now requires: ${o.featuresAdded.join(", ")}.` : "No new manifest features.",
    "",
    "## Reviewer checklist",
    "",
    "- [ ] Every object is one the requester agreed, its script ID follows ns-conventions, and no object outside this project uses it in NetSuite (a deploy would take that object over).",
  ];
  if (o.notes) out.push(`- [ ] Requester's notes for the reviewer: ${o.notes}`);
  if (fields.length) {
    out.push(
      "- [ ] Fields: label, type, where it applies, mandatory and default are what was agreed. If ns_field_plan reported tables it could not check, confirm the script ID is unused there.",
    );
  }
  for (const t of o.templates) {
    out.push(
      `- [ ] Template \`${t.scriptId}\`: read every \`src\`, \`href\`, \`url(...)\` and \`<link>\` in \`${t.file}\`. Accept only NetSuite-hosted resources (fonts via \`\${nsfont.*}\`, the company logo, \`/core/media/\` files), never an address built from record data. The sdf-gen check is a lint FreeMarker can get round; this review is the control.`,
      `- [ ] Template \`${t.scriptId}\`: read any FreeMarker that builds an address or assigns a variable (an assignment can shadow \`nsfont\` or \`companyInformation\`), and confirm \`<preferred>F</preferred>\`.`,
      "",
      `  Resource values in \`${t.scriptId}\` (${t.resources.length}):`,
      "",
      fenced(t.resources.length ? t.resources.slice(0, 50) : ["(none)"])
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
      "",
      `  Assigned variables: ${t.assignments.length ? t.assignments.map((a) => `\`${a}\``).join(", ") : "none"}.`,
      "",
    );
  }
  out.push(
    "",
    "## After merge",
    "",
    "Run the `deploy-sdf` workflow on the merge commit: approve the sandbox stage, verify there, then approve the production stage (docs/release.md). Roll back with a revert PR and the same workflow. SDF deploys never delete objects: removing an added field or template also needs a NetSuite admin to delete it in the UI.",
    "",
    "Opened by `ns_change_open_pr` (netsuite-agent gateway) with the local gh login.",
  );
  return out.join("\n");
}

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(10)
    .max(max)
    .refine((s) => !/[\r\n]/.test(s), "title must be one line")
    .refine((s) => !CONTROL.test(s), "control characters are not allowed");

export const nsChangeOpenPr = defineTool({
  name: "ns_change_open_pr",
  title: "Open a pull request for generated SDF objects",
  description:
    "Commits the SDF files that ns_field_generate or ns_pdf_template_generate wrote for the given script IDs (plus " +
    "manifest.xml if it changed) onto a new nsagent/ branch from origin/main, pushes it to dja0086/netsuite-agent and " +
    "opens a pull request with the local gh login. The PR body lists the objects and the reviewer's checklist. Never " +
    "touches the working tree or the current branch, never calls NetSuite. Refuses unless the SDF project is " +
    "netsuite/src of a git checkout whose origin is dja0086/netsuite-agent, gh's active account is dja0086, and the " +
    "working tree has no changes other than those objects' files and manifest.xml. Publishes to GitHub: call it only " +
    "after the user agreed to open the PR.",
  writes: false,
  localWrites: true,
  input: z.object({
    title: oneLine(100).describe("PR title and commit subject, e.g. Add the standard invoice template"),
    summary: z.string().trim().min(10).max(2000).refine((s) => !CONTROL.test(s), "control characters are not allowed").describe("What the change is for, in the requester's words"),
    scriptIds: z
      .array(z.string().regex(SCRIPT_ID, "script IDs must be nsagent fields or templates (custbody_, custentity_, custitem_ or custtmpl_nsagent_...)"))
      .min(1)
      .max(10)
      .describe("The generated objects this PR carries"),
    notes: z.string().trim().max(2000).refine((s) => !CONTROL.test(s), "control characters are not allowed").optional().describe("Anything the reviewer must confirm, e.g. tables ns_field_plan could not check"),
  }),
  async handler({ title, summary, scriptIds, notes }) {
    const ids = [...new Set(scriptIds)];
    const root = await projectRoot();
    const outside = `${root} is not ${SDF_SRC} of a git checkout of ${CHANGE_REPO}`;
    let top: string;
    try {
      top = await realpath((await commands.run("git", ["rev-parse", "--show-toplevel"], { cwd: root })).trim());
    } catch {
      throw new ToolInputError(outside);
    }
    if (path.join(top, SDF_SRC) !== root) throw new ToolInputError(outside);
    const git = (args: string[], opts: { env?: Record<string, string>; input?: string } = {}) =>
      commands.run("git", args, { cwd: top, ...opts }).then((s) => s.trim());

    try {
      for (const kind of [[], ["--push"]]) {
        const urls = (await git(["remote", "get-url", ...kind, "--all", "origin"])).split("\n").filter(Boolean);
        const wrong = urls.find((u) => !ORIGIN.test(u));
        if (!urls.length || wrong) {
          throw new ToolInputError(`origin ${kind.length ? "push" : "fetch"} URL is ${wrong ?? "(none)"}, not github.com/${CHANGE_REPO}; repoint origin first`);
        }
      }
      let login: string;
      try {
        login = (await commands.run("gh", ["api", "user", "--jq", ".login"], { cwd: top })).trim();
      } catch (error) {
        throw new ToolInputError(`gh is not logged in to github.com (${(error as Error).message.slice(0, 120)})`);
      }
      if (login !== CHANGE_GH_ACCOUNT) {
        throw new ToolInputError(`gh's active account is ${login}, not ${CHANGE_GH_ACCOUNT}; run gh auth switch --user ${CHANGE_GH_ACCOUNT}`);
      }

      // Only the objects' own files and manifest.xml may differ from HEAD; anything else means unrelated work in progress.
      const wanted = ids.flatMap(objectFiles);
      const allowed = new Set([...wanted, MANIFEST]);
      const status = parseStatus(await commands.run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: top }));
      const unrelated = status.filter((s) => !allowed.has(s.file)).map((s) => s.file);
      if (unrelated.length) {
        throw new ToolInputError(
          `the working tree has changes this PR would not carry: ${unrelated.slice(0, 10).join(", ")}${unrelated.length > 10 ? ` (+${unrelated.length - 10} more)` : ""}; ` +
            "commit, stash or discard them first",
        );
      }
      const odd = status.filter((s) => /[DRCU]/.test(s.xy));
      if (odd.length) throw new ToolInputError(`deleted, renamed or conflicted files cannot go into a change PR: ${odd.map((s) => s.file).join(", ")}`);
      for (const file of wanted) {
        const info = await lstat(path.join(top, file)).catch(() => undefined);
        if (!info?.isFile()) throw new ToolInputError(`${file} is missing (or not a regular file); generate the object first`);
      }
      const manifestChanged = status.some((s) => s.file === MANIFEST);

      await git(["fetch", "--no-tags", "origin", `+refs/heads/${BASE}:refs/remotes/origin/${BASE}`]);
      const base = await git(["rev-parse", "--verify", `refs/remotes/origin/${BASE}^{commit}`]);
      if (manifestChanged && (await git(["rev-parse", `${base}:${MANIFEST}`])) !== (await git(["rev-parse", `HEAD:${MANIFEST}`]))) {
        throw new ToolInputError(`HEAD's ${MANIFEST} differs from origin/${BASE}, so the PR would carry other changes; update the branch from origin/${BASE} first`);
      }

      // Build the commit in a private index from origin/main: the working tree, index and current branch stay untouched.
      const tmp = await mkdtemp(path.join(tmpdir(), "ns-agent-pr-"));
      try {
        const env = { GIT_INDEX_FILE: path.join(tmp, "index") };
        await git(["read-tree", base], { env });
        for (const file of manifestChanged ? [...wanted, MANIFEST] : wanted) {
          const blob = await git(["hash-object", "-w", "--", file]);
          await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${file}`], { env });
        }
        const tree = await git(["write-tree"], { env });
        const changed = (await git(["diff-tree", "-r", "--name-only", `${base}^{tree}`, tree])).split("\n").filter(Boolean);
        if (!changed.length) throw new ToolInputError(`nothing to commit: the files already match origin/${BASE}`);
        const stray = changed.filter((f) => !allowed.has(f));
        if (stray.length) throw new Error(`unexpected paths in the change tree: ${stray.join(", ")}`);

        const message = `${title}\n\n${summary}\n\nObjects: ${ids.join(", ")}\nOpened with ns_change_open_pr (netsuite-agent gateway).\n`;
        const commit = await git(["commit-tree", tree, "-p", base, "-F", "-"], { input: message });
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
        const branch = `nsagent/${slug || "change"}-${commit.slice(0, 8)}`;
        await git(["push", "origin", `${commit}:refs/heads/${branch}`]);

        const baseManifest = await git(["show", `${base}:${MANIFEST}`]);
        const newManifest = await readFile(path.join(top, MANIFEST), "utf8");
        const before = features(baseManifest);
        const templates: TemplateReview[] = [];
        for (const id of ids.filter((i) => i.startsWith("custtmpl_"))) {
          const file = objectFiles(id)[1]!;
          templates.push({ scriptId: id, file, ...templateReviewPoints(await readFile(path.join(top, file), "utf8")) });
        }
        const body = prBody({
          summary,
          notes,
          scriptIds: ids,
          files: changed,
          featuresAdded: [...features(manifestChanged ? newManifest : baseManifest)].filter((f) => !before.has(f)),
          templates,
        });
        let pr: { number: number; html_url: string };
        try {
          const out = await commands.run("gh", ["api", "-X", "POST", `repos/${CHANGE_REPO}/pulls`, "--input", "-"], {
            cwd: top,
            input: JSON.stringify({ title, head: branch, base: BASE, body }),
          });
          pr = JSON.parse(out) as { number: number; html_url: string };
        } catch (error) {
          throw new ToolInputError(`pushed ${branch} but could not open the pull request (${(error as Error).message.slice(0, 200)}); open it on GitHub from that branch`);
        }
        return {
          url: pr.html_url,
          number: pr.number,
          branch,
          commit,
          base,
          committed: changed,
          next: "CI validates the project; a reviewer works through the checklist in the PR. After merge, the deploy-sdf workflow deploys it with a named approver per stage.",
        };
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    } catch (error) {
      if (error instanceof CommandError) throw new ToolInputError(error.message);
      throw error;
    }
  },
});

export const changeControlTools = [nsChangeOpenPr] as unknown as ToolDef[];
