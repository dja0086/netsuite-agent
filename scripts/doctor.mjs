#!/usr/bin/env node
/**
 * node scripts/doctor.mjs [--tools-only]
 * Verifies every dependency and setting this repo needs, on the machine it runs on. Assumes nothing.
 * Uses only Node built-ins so it runs before `pnpm install`. Never prints secret values.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsOnly = process.argv.includes("--tools-only");
const results = [];
const add = (group, name, status, detail, fix) => results.push({ group, name, status, detail, fix });

/**
 * Runs a command. Returns its output (stdout, or stderr when stdout is empty: `java -version` writes to stderr),
 * "__FAILED__<output>" when it exits non-zero, or null when the command does not exist.
 */
function run(cmd, args, timeout = 30_000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout });
  if (r.error) return r.error.code === "ENOENT" ? null : `__FAILED__${r.error.message}`;
  const out = (r.stdout ?? "").trim() || (r.stderr ?? "").trim();
  return r.status === 0 ? out : `__FAILED__${out}`;
}
const major = (v) => Number(String(v).replace(/^v/, "").split(".")[0]);

// ---------- Tools ----------
const nodeV = process.versions.node;
major(nodeV) >= 22
  ? add("tools", "Node.js", "PASS", `v${nodeV}`)
  : add("tools", "Node.js", "FAIL", `v${nodeV}; need 22 or newer`, "Install Node 22 LTS (nodejs.org or a version manager)");

const pnpmV = run("pnpm", ["--version"]);
if (!pnpmV || pnpmV.startsWith("__FAILED__")) add("tools", "pnpm", "FAIL", "not found", major(nodeV) >= 25 ? "Run `npm install -g pnpm@10.28.0` (Node 25+ no longer ships corepack)" : "Run `corepack enable` (ships with Node 22-24), or `npm install -g pnpm@10.28.0`");
else if (major(pnpmV) !== 10) add("tools", "pnpm", "WARN", `${pnpmV}; repo pins pnpm 10`, "Run `npm install -g pnpm@10.28.0`");
else add("tools", "pnpm", "PASS", pnpmV);

const gitV = run("git", ["--version"]);
gitV && !gitV.startsWith("__FAILED__")
  ? add("tools", "git", "PASS", gitV.replace("git version ", ""))
  : add("tools", "git", "FAIL", "not found", "macOS: run `xcode-select --install`");

const javaV = run("java", ["-version"]);
if (!javaV || javaV.startsWith("__FAILED__")) // missing, or the macOS stub "Unable to locate a Java Runtime" (exit 1)
  add("tools", "Java (for SuiteCloud CLI)", "FAIL", "no JDK found", "Install JDK 21 (`brew install --cask temurin@21`, or Oracle JDK 21), then reopen the terminal");
else {
  const m = /version "(\d+)/.exec(javaV);
  const jm = m ? Number(m[1]) : NaN;
  [17, 21].includes(jm)
    ? add("tools", "Java (for SuiteCloud CLI)", "PASS", `JDK ${jm}`)
    : add("tools", "Java (for SuiteCloud CLI)", "WARN", `JDK ${Number.isNaN(jm) ? "unknown" : jm}; SuiteCloud CLI supports 17 or 21`, "Install JDK 17 or 21 and make it the default");
}

const scV = run("suitecloud", ["--version"], 60_000);
!scV || scV.startsWith("__FAILED__")
  ? add("tools", "SuiteCloud CLI", "FAIL", "`suitecloud` not on PATH", "`npm install -g @oracle/suitecloud-cli` (needed for SDF deploys and server validation)")
  : add("tools", "SuiteCloud CLI", "PASS", scV.split("\n").at(-1));

if (major(nodeV) !== 24)
  add("tools", "Node.js for SuiteCloud CLI", "WARN", `Oracle supports Node 24 LTS for the SuiteCloud CLI; this is v${nodeV}`,
    "If `suitecloud` commands fail, run them under Node 24 LTS (e.g. `brew install node@24`)");

const claudeV = run("claude", ["--version"]);
!claudeV || claudeV.startsWith("__FAILED__")
  ? add("tools", "Claude Code CLI", "WARN", "`claude` not on PATH (fine if you use the desktop app)", "Install Claude Code if you want to work from the terminal")
  : add("tools", "Claude Code CLI", "PASS", claudeV);

const antV = run("ant", ["--version"]);
if (!antV || antV.startsWith("__FAILED__")) add("tools", "ant CLI", "FAIL", "`ant` not on PATH", "Install the Anthropic CLI (`brew install anthropics/tap/ant`), then `ant auth login`");
else {
  add("tools", "ant CLI", "PASS", antV.replace("ant version ", ""));
  // Exit code only: the status output names the credential and is never printed.
  const auth = spawnSync("ant", ["auth", "status"], { encoding: "utf8", timeout: 30_000 });
  auth.status === 0 ? add("tools", "ant login", "PASS", "logged in (agent builder, Managed Agents)") : add("tools", "ant login", "FAIL", "not logged in", "Run `ant auth login` (workspace \"Default\")");
}

const ghV = run("gh", ["auth", "status", "--active"]);
if (ghV === null) add("tools", "GitHub CLI", "FAIL", "`gh` not on PATH", "`brew install gh`, then `gh auth login` as dja0086");
else if (ghV.startsWith("__FAILED__")) add("tools", "GitHub CLI", "FAIL", "not logged in", "Run `gh auth login` as dja0086");
else /account dja0086/.test(ghV)
  ? add("tools", "GitHub CLI", "PASS", "active account dja0086 (pushes, waiting-run issues)")
  : add("tools", "GitHub CLI", "WARN", "active account is not dja0086", "Run `gh auth switch --user dja0086`");

// ---------- Repo ----------
existsSync(path.join(repoRoot, ".git"))
  ? add("repo", "git repository", "PASS", run("git", ["-C", repoRoot, "log", "-1", "--format=%h %s"]) ?? "")
  : add("repo", "git repository", "FAIL", "no .git folder", "Unpack the full netsuite-agent.zip (it includes history)");
existsSync(path.join(repoRoot, "node_modules", ".pnpm"))
  ? add("repo", "dependencies installed", "PASS", "node_modules present")
  : add("repo", "dependencies installed", "FAIL", "node_modules missing", "Run `pnpm install` in the repo folder");

// ---------- Config ----------
if (!toolsOnly) {
  const lock = path.join(repoRoot, "managed-agents", "phase0", "claude-lock.json");
  if (!existsSync(lock)) add("config", "Managed Agents lock file", "FAIL", "managed-agents/phase0/claude-lock.json missing", "Restore it from git; the builder reads the environment and vault ids from it");
  else {
    const text = readFileSync(lock, "utf8");
    /env_[A-Za-z0-9]+/.test(text) && /vlt_[A-Za-z0-9]+/.test(text)
      ? add("config", "Managed Agents lock file", "PASS", "environment and NetSuite vault ids present")
      : add("config", "Managed Agents lock file", "FAIL", "no environment or vault id found", "Re-run Phase 0's `ant apply` (docs/phase0-managed-agents.md)");
  }
  const data = path.join(repoRoot, "apps", "agent-builder", "data");
  existsSync(path.join(data, "agents.json"))
    ? add("config", "builder registry", "PASS", "apps/agent-builder/data/agents.json present")
    : add("config", "builder registry", "WARN", "no agents.json yet", "Normal before the first agent; if it was lost, the agents still exist on Anthropic's side (docs/agent-builder.md)");
  if (process.platform === "darwin") {
    const job = spawnSync("launchctl", ["print", `gui/${process.getuid()}/com.dja0086.netsuite-agent.builder-pending`], { encoding: "utf8" });
    job.status === 0
      ? add("config", "waiting-run check (launchd)", "PASS", "com.dja0086.netsuite-agent.builder-pending loaded")
      : add("config", "waiting-run check (launchd)", "WARN", "not loaded: waiting scheduled runs will not open GitHub issues", "Install it as in docs/agent-builder.md");
  }
}

// ---------- Report ----------
const icon = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
let group = "";
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    console.log(`\n${group.toUpperCase()}`);
  }
  console.log(`  ${icon[r.status]}  ${r.name}: ${r.detail}${r.status !== "PASS" && r.fix ? `\n        fix: ${r.fix}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const warns = results.filter((r) => r.status === "WARN");
console.log(`\n${fails.length} failed, ${warns.length} warnings, ${results.length - fails.length - warns.length} passed`);
process.exit(fails.length ? 1 : 0);
