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
 * Every tracked file is scanned; none is skipped. UTF-8 is the default. A
 * file with a UTF-16 byte-order mark, or with the NUL pattern of UTF-16 text,
 * is decoded as UTF-16. Any other file with a NUL byte, or larger than
 * MAX_BYTES, is scanned as raw bytes (latin1), so binary files are scanned too.
 * Zero-width characters are removed before matching.
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

/** Above this size a file is scanned as raw bytes rather than decoded. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Zero-width and invisible formatting characters that can split an
 * identifier without changing how it looks: zero-width space, non-joiner and
 * joiner, word joiner, invisible operators, BOM / zero-width no-break space,
 * soft hyphen, Mongolian vowel separator.
 */
const INVISIBLE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u00AD\u180E]/g;

/** Removes zero-width characters before matching. */
export const stripInvisible = text => text.replace(INVISIBLE, '');

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
const hostAccountIsReal = account => {
  account = account.toLowerCase();
  if (!/\d/.test(account)) return false; // placeholders such as "system"
  const digits = account.replace(/^[a-z]+/, '');
  // Real account numbers have at least five digits; "1" or "123" are stubs.
  if (!/^\d{5,}$/.test(digits)) return false;
  return !isFictionalAccountNumber(digits);
};

export const PATTERNS = [
  {
    category: 'netsuite-account-id',
    // Test-drive style account IDs: TSTDRV and five or more digits, wherever
    // they sit ("X_TSTDRV<n>", "TSTDRV<n>_prod", "TSTDRV<n>abc").
    regex: /TSTDRV(\d{5,})(?!\d)/gi,
    keep: match => !isFictionalAccountNumber(match[1]),
  },
  {
    category: 'netsuite-account-id',
    // Numeric sandbox and release-preview account IDs: <n>_SB1, <n>-rp2.
    regex: /(?<!\d)(\d{6,8})[_-](?:SB|RP)\d+(?!\d)/gi,
    keep: match => !isFictionalAccountNumber(match[1]),
  },
  {
    category: 'netsuite-account-host',
    // <account>.suitetalk.api.netsuite.com and the other account domains,
    // including the SuiteAnalytics Connect (ODBC) host.
    regex:
      /\b([a-z0-9]+)(?:-(?:sb|rp)\d+)?\.(?:suitetalk\.api|restlets\.api|connect\.api|app|extforms|suitetalk|forms|secure|checkout)\.netsuite\.com\b/gi,
    keep: match => hostAccountIsReal(match[1]),
  },
  {
    category: 'netsuite-account-host',
    // An account in a NetSuite URL's query string: system.netsuite.com/...?c=<n>.
    regex:
      /netsuite\.com\/[^\s"'<>)]*?[?&](?:c|compid|account)=([A-Za-z0-9_-]+)/gi,
    keep: match =>
      hostAccountIsReal(match[1].replace(/[_-](?:sb|rp)\d+$/i, '')),
  },
  {
    category: 'managed-agents-id',
    // Claude Managed Agents resource IDs (agent_, env_, vlt_, vcrd_, sesn_,
    // depl_ and other prefixes), in any case: a short prefix, _01, then at
    // least 12 more letters and digits. Short fixtures such as vlt_01NetSuite pass.
    // Bounded by any non-alphanumeric character, so `_x` after it or `X_`
    // before it does not hide one.
    regex: /(?<![A-Za-z0-9])[a-z]{2,8}_01[A-Za-z0-9]{12,}(?![A-Za-z0-9])/gi,
    keep: () => true,
  },
];

/**
 * Between the words of a denylist entry: spaces, hyphens, underscores, dots,
 * plus signs or %20, or nothing ("Acme Widgets", "acme-widgets",
 * "Acme%20Widgets", "AcmeWidgets").
 */
const SEPARATOR = '(?:[\\s_+.-]|%20)*';

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Between the digits of a denylisted number of seven or more digits (an
 * account number): at most one space, dot or hyphen ("765-4321", "765 4321").
 */
const DIGIT_SEPARATOR = '[\\s.\\u2010-\\u2014-]?';

const entryPattern = entry =>
  /^\d{7,}$/.test(entry)
    ? entry.split('').join(DIGIT_SEPARATOR)
    : entry.split(/\s+/).map(escapeRegex).join(SEPARATOR);

/**
 * Parses IDENTIFIER_DENYLIST: one literal per line; blank lines and # comments
 * ignored. Matching is case-insensitive and on whole words; a name split
 * across two lines is not matched, and neither is a number inside a longer
 * run of digits.
 */
export function parseDenylist(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(entry => entry.length >= 3 && !entry.startsWith('#'))
    .map(
      entry =>
        new RegExp(
          `(?<![A-Za-z0-9])${entryPattern(entry)}(?![A-Za-z0-9])`,
          'gi'
        )
    );
}

/** Returns [{ line, category }] for one file's text. */
export function scanText(text, denylist = []) {
  const hits = [];
  const lines = stripInvisible(text).split(/\r?\n/);
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

/**
 * Guesses UTF-16 from where the NUL bytes sit in the first 4 KB: ASCII text in
 * UTF-16LE has a NUL at most odd offsets and none at even ones (BE the
 * reverse). Returns 'le', 'be' or null.
 */
function utf16Order(buffer) {
  const sample = buffer.subarray(0, 4096);
  let even = 0;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) i % 2 ? odd++ : even++;
  }
  const pairs = Math.floor(sample.length / 2);
  if (pairs < 2) return null;
  if (odd >= pairs * 0.3 && even <= pairs * 0.05) return 'le';
  if (even >= pairs * 0.3 && odd <= pairs * 0.05) return 'be';
  return null;
}

/**
 * Decodes a file's bytes for scanning. Returns { texts, mode }: mode is
 * 'utf8', 'utf16' or 'bytes', and texts are the views to scan. Never refuses a
 * file. A UTF-16 file is also scanned as raw bytes, so a byte-order mark put
 * in front of ASCII text cannot hide what follows; real UTF-16 text has a NUL
 * between its characters, so that view adds no hits.
 */
export function decodeForScan(buffer) {
  const bom =
    buffer[0] === 0xff && buffer[1] === 0xfe
      ? 'le'
      : buffer[0] === 0xfe && buffer[1] === 0xff
        ? 'be'
        : null;
  const order = bom ?? (buffer.includes(0) ? utf16Order(buffer) : null);
  if (order) {
    let body = Buffer.from(buffer.subarray(bom ? 2 : 0));
    if (body.length % 2) body = body.subarray(0, body.length - 1);
    if (order === 'be') body.swap16();
    return {
      texts: [body.toString('utf16le'), buffer.toString('latin1')],
      mode: 'utf16',
    };
  }
  if (buffer.length > MAX_BYTES || buffer.includes(0)) {
    return { texts: [buffer.toString('latin1')], mode: 'bytes' };
  }
  return { texts: [buffer.toString('utf8')], mode: 'utf8' };
}

function readTrackedFile(path) {
  try {
    if (!statSync(path).isFile()) return null;
    return decodeForScan(readFileSync(path));
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
  const modes = { utf16: 0, bytes: 0 };
  for (const path of trackedFiles(args.root)) {
    const file = readTrackedFile(join(args.root, path));
    if (file === null) continue;
    const { texts, mode } = file;
    scanned++;
    if (mode in modes) modes[mode]++;
    const hits = texts.flatMap(text => scanText(text, denylist));
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
    `scanned ${scanned} tracked files (${modes.utf16} as UTF-16, ${modes.bytes} as raw bytes); ${Object.keys(countsByFile).length} hold identifiers; ${Object.keys(baseline).length} baselined`
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
