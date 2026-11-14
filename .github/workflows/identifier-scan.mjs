#!/usr/bin/env node
/**
 * Identifier scan (plan invariant I9).
 *
 * Scans the files git tracks in the current tree (never history) for NetSuite
 * account IDs, account hostnames and Claude Managed Agents resource IDs, plus
 * optional literal strings from the IDENTIFIER_DENYLIST environment variable
 * (one entry per line, supplied from an Actions secret: client names, bare
 * account numbers, internal IDs). Files that already held identifiers when the
 * scan was introduced are listed in a baseline with a count per category; the
 * scan fails when a file outside the baseline has any hit, or a baselined file
 * has more hits in a category than its baseline allows.
 *
 * Output names the file, the line and the category, never the matched text,
 * so a public CI log cannot leak what it found. This file and the baseline hold
 * patterns and paths only, never a literal identifier.
 *
 * The same file is used in suitereact-mcp (.github/scripts/), netsuite-agent
 * and deploymentagent (.github/workflows/).
 *
 * Usage:
 *   node identifier-scan.mjs [--baseline <file>] [--root <dir>]
 *   node identifier-scan.mjs --baseline <file> --write-baseline
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * An account number is fictional when it is the documented example
 * (1234567) or starts with at least four zeros (synthetic fixtures such as
 * the ones deploymentagent uses). Real IDs are therefore never needed in a
 * test: use one of these shapes.
 */
export function isFictionalAccountNumber(digits) {
  return digits === '1234567' || /^0{4,}\d*$/.test(digits);
}

/** Categories and their patterns. Each returns the hits on one line. */
export const PATTERNS = [
  {
    category: 'netsuite-account-id',
    // Test-drive style account IDs: a letter prefix and five or more digits.
    regex: /\bTSTDRV(\d{5,})(?:_(?:SB|RP)\d+)?\b/gi,
    keep: match => !isFictionalAccountNumber(match[1]),
  },
  {
    category: 'netsuite-account-id',
    // Numeric sandbox and release-preview account IDs.
    regex: /\b(\d{6,8})_(?:SB|RP)\d+\b/gi,
    keep: match => !isFictionalAccountNumber(match[1]),
  },
  {
    category: 'netsuite-account-host',
    // <account>.suitetalk.api.netsuite.com and the other account domains.
    regex:
      /\b([a-z0-9]+)(?:-(?:sb|rp)\d+)?\.(?:suitetalk\.api|restlets\.api|app|extforms|suitetalk)\.netsuite\.com\b/gi,
    keep: match => {
      const account = match[1].toLowerCase();
      if (!/\d/.test(account)) return false; // placeholders such as "system"
      const digits = account.replace(/^[a-z]+/, '');
      // Real account numbers have at least five digits; "1" or "123" are stubs.
      if (!/^\d{5,}$/.test(digits)) return false;
      return !isFictionalAccountNumber(digits);
    },
  },
  {
    category: 'managed-agents-id',
    // Claude Managed Agents resource IDs: agent, environment, vault,
    // credential, session, deployment and file IDs.
    regex:
      /\b(?:agent|env|vlt|vcrd|sesn|depl|file|skill|msg)_01[A-Za-z0-9]{16,}\b/g,
    keep: () => true,
  },
];

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parses IDENTIFIER_DENYLIST: one literal per line; blank lines and # comments ignored. */
export function parseDenylist(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(entry => entry.length >= 3 && !entry.startsWith('#'))
    .map(
      entry =>
        new RegExp(
          `(?<![A-Za-z0-9])${escapeRegex(entry).replace(/\s+/g, '\\s+')}(?![A-Za-z0-9])`,
          'gi'
        )
    );
}

/** Returns [{ line, category }] for one file's text. */
export function scanText(text, denylist = []) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((content, index) => {
    for (const { category, regex, keep } of PATTERNS) {
      for (const match of content.matchAll(regex)) {
        if (keep(match)) hits.push({ line: index + 1, category });
      }
    }
    for (const regex of denylist) {
      for (const _ of content.matchAll(regex)) {
        hits.push({ line: index + 1, category: 'denylist' });
      }
    }
  });
  return hits;
}

/** Counts hits per category: { category: n }. */
export function countByCategory(hits) {
  const counts = {};
  for (const { category } of hits)
    counts[category] = (counts[category] ?? 0) + 1;
  return counts;
}

/**
 * Compares the counts of every scanned file with the baseline.
 * Returns { failures: [{ path, category, found, allowed }], lowerable: [path] }.
 */
export function compareWithBaseline(
  countsByFile,
  baseline,
  { denylistActive = true } = {}
) {
  const failures = [];
  const lowerable = [];
  for (const [path, counts] of Object.entries(countsByFile)) {
    const allowed = baseline[path] ?? {};
    for (const [category, found] of Object.entries(counts)) {
      if (found > (allowed[category] ?? 0)) {
        failures.push({
          path,
          category,
          found,
          allowed: allowed[category] ?? 0,
        });
      }
    }
  }
  for (const [path, allowed] of Object.entries(baseline)) {
    const counts = countsByFile[path] ?? {};
    const below = Object.entries(allowed).some(
      ([category, n]) =>
        (denylistActive || category !== 'denylist') &&
        (counts[category] ?? 0) < n
    );
    if (below) {
      lowerable.push(path);
    }
  }
  return { failures, lowerable };
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

function readTextFile(path) {
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_BYTES)
      return null;
    const buffer = readFileSync(path);
    if (buffer.includes(0)) return null; // binary
    return buffer.toString('utf8');
  } catch {
    return null; // deleted in the working tree or unreadable
  }
}

function parseArgs(argv) {
  const args = { root: process.cwd(), baseline: null, write: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = resolve(argv[++i]);
    else if (argv[i] === '--baseline') args.baseline = argv[++i];
    else if (argv[i] === '--write-baseline') args.write = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const denylist = parseDenylist(env.IDENTIFIER_DENYLIST);
  console.log(
    denylist.length
      ? `identifier scan: generic patterns plus ${denylist.length} denylist entries`
      : 'identifier scan: generic patterns only (IDENTIFIER_DENYLIST is not set)'
  );

  const baselinePath = args.baseline ? resolve(args.root, args.baseline) : null;
  const baseline =
    baselinePath && existsSync(baselinePath)
      ? (JSON.parse(readFileSync(baselinePath, 'utf8')).files ?? {})
      : {};

  const countsByFile = {};
  const linesByFile = {};
  let scanned = 0;
  for (const path of trackedFiles(args.root)) {
    const text = readTextFile(join(args.root, path));
    if (text === null) continue;
    scanned++;
    const hits = scanText(text, denylist);
    if (hits.length) {
      countsByFile[path] = countByCategory(hits);
      linesByFile[path] = hits;
    }
  }

  if (args.write) {
    const sorted = Object.fromEntries(
      Object.keys(countsByFile)
        .sort()
        .map(path => [path, countsByFile[path]])
    );
    const body = {
      about:
        'Files that held identifiers when the identifier scan was introduced, with a count per category. Paths and counts only, never the identifiers. Lower or remove an entry when its file is cleaned; raising one needs approval by the owner (the approved-adr label in the platform repo).',
      files: sorted,
    };
    writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`);
    console.log(
      `wrote ${Object.keys(sorted).length} entries to ${args.baseline}`
    );
    return 0;
  }

  const { failures, lowerable } = compareWithBaseline(countsByFile, baseline, {
    denylistActive: denylist.length > 0,
  });
  console.log(
    `scanned ${scanned} tracked text files; ${Object.keys(countsByFile).length} hold identifiers; ${Object.keys(baseline).length} baselined`
  );
  for (const path of lowerable) {
    console.log(
      `note: ${path} has fewer hits than its baseline; lower the baseline entry`
    );
  }
  if (!failures.length) {
    console.log('identifier scan passed');
    return 0;
  }
  for (const { path, category, found, allowed } of failures) {
    const lines = linesByFile[path]
      .filter(hit => hit.category === category)
      .map(hit => hit.line)
      .join(', ');
    console.log(
      `::error file=${path}::identifier scan: ${category} found ${found}, baseline allows ${allowed} (lines ${lines})`
    );
  }
  console.log(
    `identifier scan failed: ${failures.length} finding(s); matched text is not printed`
  );
  return 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
