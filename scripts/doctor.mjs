#!/usr/bin/env node
/**
 * node scripts/doctor.mjs [--tools-only]
 * Verifies every dependency and setting this repo needs, on the machine it runs on. Assumes nothing.
 * Uses only Node built-ins so it runs before `pnpm install`. Never prints secret values.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsOnly = process.argv.includes("--tools-only");
const results = [];
const add = (group, name, status, detail, fix) => results.push({ group, name, status, detail, fix });

/** Runs a command and returns combined output, or null when it is missing or fails. */
function run(cmd, args, timeout = 30_000) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
  } catch (error) {
    const out = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return error.code === "ENOENT" ? null : out ? `__FAILED__${out}` : null;
  }
}
const major = (v) => Number(String(v).replace(/^v/, "").split(".")[0]);

// ---------- Tools ----------
const nodeV = process.versions.node;
major(nodeV) >= 22
  ? add("tools", "Node.js", "PASS", `v${nodeV}`)
  : add("tools", "Node.js", "FAIL", `v${nodeV}; need 22 or newer`, "Install Node 22 LTS (nodejs.org or a version manager)");

const pnpmV = run("pnpm", ["--version"]);
if (!pnpmV || pnpmV.startsWith("__FAILED__")) add("tools", "pnpm", "FAIL", "not found", "Run `corepack enable` (ships with Node), then reopen the terminal");
else if (major(pnpmV) !== 10) add("tools", "pnpm", "WARN", `${pnpmV}; repo pins pnpm 10`, "`corepack enable` makes pnpm follow the repo's packageManager pin");
else add("tools", "pnpm", "PASS", pnpmV);

const gitV = run("git", ["--version"]);
gitV && !gitV.startsWith("__FAILED__")
  ? add("tools", "git", "PASS", gitV.replace("git version ", ""))
  : add("tools", "git", "FAIL", "not found", "macOS: run `xcode-select --install`");

const sslV = run("openssl", ["version"]);
if (!sslV || sslV.startsWith("__FAILED__")) add("tools", "OpenSSL", "FAIL", "not found", "Install OpenSSL 3 (macOS: `brew install openssl@3`)");
else if (/LibreSSL/i.test(sslV))
  add("tools", "OpenSSL", "WARN", `${sslV}: the RSA-PSS certificate command may not work with LibreSSL`,
    "Use OpenSSL 3 (`brew install openssl@3`), or create an EC (ES256) certificate and set NS_JWT_ALG=ES256");
else add("tools", "OpenSSL", "PASS", sslV);

const javaV = run("java", ["-version"]);
if (!javaV || javaV.startsWith("__FAILED__") && /Unable to locate|No Java runtime/i.test(javaV))
  add("tools", "Java (for SuiteCloud CLI)", "FAIL", "no JDK found", "Install JDK 17 or 21 (e.g. Oracle JDK or Temurin), then reopen the terminal");
else {
  const m = /version "(\d+)/.exec(javaV);
  const jm = m ? Number(m[1]) : NaN;
  [17, 21].includes(jm)
    ? add("tools", "Java (for SuiteCloud CLI)", "PASS", `JDK ${jm}`)
    : add("tools", "Java (for SuiteCloud CLI)", "WARN", `JDK ${Number.isNaN(jm) ? "unknown" : jm}; SuiteCloud CLI supports 17 or 21`, "Install JDK 17 or 21 and make it the default");
}

const scV = run("suitecloud", ["--version"], 60_000);
!scV || scV.startsWith("__FAILED__")
  ? add("tools", "SuiteCloud CLI", "FAIL", "`suitecloud` not on PATH", "`npm install -g @oracle/suitecloud-cli` (needed to deploy the explore RESTlet in CP1)")
  : add("tools", "SuiteCloud CLI", "PASS", scV.split("\n").at(-1));

const claudeV = run("claude", ["--version"]);
!claudeV || claudeV.startsWith("__FAILED__")
  ? add("tools", "Claude Code CLI", "WARN", "`claude` not on PATH (fine if you use the desktop app)", "Install Claude Code if you want to work from the terminal")
  : add("tools", "Claude Code CLI", "PASS", claudeV);

// ---------- Repo ----------
existsSync(path.join(repoRoot, ".git"))
  ? add("repo", "git repository", "PASS", run("git", ["-C", repoRoot, "log", "-1", "--format=%h %s"]) ?? "")
  : add("repo", "git repository", "FAIL", "no .git folder", "Unpack the full netsuite-agent.zip (it includes history)");
existsSync(path.join(repoRoot, "node_modules", ".pnpm"))
  ? add("repo", "dependencies installed", "PASS", "node_modules present")
  : add("repo", "dependencies installed", "FAIL", "node_modules missing", "Run `pnpm install` in the repo folder");

// ---------- Config (expected to fail until CP0 is done) ----------
if (!toolsOnly) {
  const envFile = path.join(repoRoot, ".env");
  if (!existsSync(envFile)) {
    add("config", ".env", "FAIL", "missing", "Copy .env.example to .env and fill in the IDs after CP0");
  } else {
    const env = Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
    );
    const ignored = run("git", ["-C", repoRoot, "check-ignore", "-q", ".env"]);
    ignored === "" ? add("config", ".env is git-ignored", "PASS", "yes") : add("config", ".env is git-ignored", "FAIL", "git would commit .env", "Restore .gitignore from the repo");

    const need = (k, ok, hint) =>
      !env[k] ? add("config", k, "FAIL", "empty", hint) : ok(env[k]) ? add("config", k, "PASS", k.includes("ID") && k !== "NS_ACCOUNT_ID" ? "set" : env[k]) : add("config", k, "FAIL", `invalid: ${env[k]}`, hint);
    need("NS_ACCOUNT_ID", (v) => /^[A-Za-z0-9_]+$/.test(v), "Setup > Company > Company Information > Account ID");
    need("NS_TARGET_KIND", (v) => ["sandbox", "demo"].includes(v.toLowerCase()), "sandbox or demo (production is refused for live tests)");
    need("NS_CLIENT_ID", (v) => v.length >= 20, "Client ID shown once when the integration record was saved");
    need("NS_CERT_ID", (v) => v.length >= 10, "Certificate ID from the OAuth 2.0 Client Credentials (M2M) Setup page");
    need("NS_MAX_CONCURRENCY", (v) => Number.isInteger(Number(v)) && Number(v) >= 1, "Integer at or below the integration's allocated concurrency");
    if (env.NS_JWT_ALG && !/^(PS|ES)(256|384|512)$/.test(env.NS_JWT_ALG))
      add("config", "NS_JWT_ALG", "FAIL", `invalid: ${env.NS_JWT_ALG}`, "PS256 (RSA-PSS certificate) or ES256 (EC certificate)");

    const backend = env.SECRETS_BACKEND || "file";
    if (backend !== "file") add("config", "SECRETS_BACKEND", "WARN", `${backend}: not checked by doctor`, "");
    else {
      const keyPath = env.NS_PRIVATE_KEY_PATH;
      if (!keyPath) add("config", "private key", "FAIL", "NS_PRIVATE_KEY_PATH empty", "Point it at private.pem stored OUTSIDE the repo");
      else {
        const resolved = path.resolve(keyPath.replace(/^~(?=\/)/, process.env.HOME ?? "~"));
        if (resolved.startsWith(repoRoot + path.sep)) add("config", "private key", "FAIL", "stored inside the repo", "Move it outside the repo, e.g. ~/.netsuite-agent/private.pem");
        else if (!existsSync(resolved)) add("config", "private key", "FAIL", "file not found at NS_PRIVATE_KEY_PATH", "Check the path (use an absolute path)");
        else {
          const buf = Buffer.alloc(64);
          const fd = openSync(resolved, "r");
          readSync(fd, buf, 0, 64, 0);
          closeSync(fd);
          const looksLikeKey = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(buf.toString("utf8"));
          const loose = process.platform !== "win32" && (statSync(resolved).mode & 0o077) !== 0;
          if (!looksLikeKey) add("config", "private key", "FAIL", "file is not a PEM private key", "Point NS_PRIVATE_KEY_PATH at private.pem, not public.pem");
          else if (loose) add("config", "private key", "WARN", "readable by other users", "Run `chmod 600` on the key file");
          else add("config", "private key", "PASS", "found outside the repo, permissions 600 (contents not read beyond the header)");
        }
      }
    }
    const drift = ["NS_ACCOUNT_ID", "NS_TARGET_KIND"].filter((k) => process.env[k] && env[k] && process.env[k] !== env[k]);
    if (drift.length) add("config", "shell environment", "WARN", `shell values differ from .env for ${drift.join(", ")}`, "Run `set -a; source .env; set +a` again");
  }
}

// ---------- Report ----------
const icon = { PASS: "PASS", WARN: "WARN", FAIL: "FAIL" };
let group = "";
for (const r of results) {
  if (r.group !== group) {
    group = r.group;
    console.log(`\n${group.toUpperCase()}${group === "config" ? " (expected to fail until CP0 is done)" : ""}`);
  }
  console.log(`  ${icon[r.status]}  ${r.name}: ${r.detail}${r.status !== "PASS" && r.fix ? `\n        fix: ${r.fix}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const warns = results.filter((r) => r.status === "WARN");
console.log(`\n${fails.length} failed, ${warns.length} warnings, ${results.length - fails.length - warns.length} passed`);
process.exit(fails.length ? 1 : 0);
