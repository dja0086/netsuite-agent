#!/usr/bin/env node
/**
 * Context scan (plan invariant I10).
 *
 * Context files (AGENTS.md, CLAUDE.md) hold rules and decisions. This scan
 * fails when one of them still carries:
 *
 * - the retired no-write rule, superseded by decision L2 (ADR 5), or
 * - a hand-kept NetSuite account fact: a record count, an internal ID, a role
 *   ID or a deployment status (amendment A6). Facts about the repo itself are
 *   not covered. Account facts come from `npm run session-start` instead.
 *
 * It also fails when a context file does not link to the plan. Output names
 * the file, the line and the rule, never the matched text.
 *
 * Usage: node context-scan.mjs [--plan-link <text>] <file>...
 *   With no files, scans AGENTS.md and CLAUDE.md in the current directory.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The retired rule, in the wordings the three repos used. */
export const RETIRED_RULE = [
  /\b(?:never|do\s+not|don['’]?t|must\s+not)\s+write\s+(?:anything\s+|data\s+)?(?:to|in|into)\s+netsuite\b/i,
  /\bno\s+netsuite\s+writes?\s+(?:outside|without|except)\b/i,
  /\bno\s+writes?\s+to\s+netsuite\s+(?:outside|without|except)\b/i,
  /\boutside\s+an?\s+approved\s+(?:agent\s+)?run\b/i,
  /\bwrites?\s+happen\s+only\s+inside\s+(?:builder\s+)?agent\s+runs\b/i,
];

const RECORD_WORDS = [
  'subsidiaries',
  'subsidiary',
  'custbody',
  'custom\\s+(?:body\\s+|entity\\s+|column\\s+)?fields',
  'records',
  'transactions',
  'invoices',
  'customers',
  'clients',
  'vendors',
  'employees',
  'roles',
  'gates',
  'agents',
  'findings',
  'deployments',
  'saved\\s+searches',
  'P&L\\s+lines',
  'lines',
].join('|');

const ID_WORDS = [
  'internal\\s+id',
  'employee',
  'integration(?:\\s+user)?',
  'client',
  'customer',
  'role',
  'script',
  'deployment',
  'file',
  'folder',
  'saved\\s+search',
  'search',
  'user',
  'deploy\\s+run',
  'run',
  'record',
  'agent',
  'certificate',
  'mapping',
].join('|');

/** Hand-kept NetSuite account facts (A6). */
export const ACCOUNT_FACTS = [
  {
    rule: 'record count',
    // "42 subsidiaries", "123 existing custbody fields", "9,999 P&L lines" (fictional)
    regex: new RegExp(
      `\\b\\d[\\d,]*\\s+(?:existing\\s+|active\\s+|open\\s+)?(?:${RECORD_WORDS})\\b`,
      'i'
    ),
  },
  {
    rule: 'internal ID',
    // "employee 9001", "internal id 9002", "deploy run 90000000001", "client 9003" (fictional)
    regex: new RegExp(`\\b(?:${ID_WORDS})\\s+(?:id\\s+)?#?\\d{3,}\\b`, 'i'),
  },
  {
    rule: 'internal ID',
    // "(internal id 9002" inside parentheses or after a name
    regex: /\binternal\s+ids?\s*[:=]?\s*\d{2,}\b/i,
  },
  { rule: 'role ID', regex: /\bcustomrole\d+\b/i },
  { rule: 'role ID', regex: /\brole\s+ids?\b[^.\n]*\b\d{2,}\b/i },
  {
    rule: 'deployment status',
    // NetSuite's status values written in upper case, as lists show them.
    regex: /\b(?:RELEASED|TESTING|NOT\s+DEPLOYED|INACTIVE|SCHEDULED)\b/,
  },
  {
    rule: 'deployment status',
    // Status words that are not ordinary English, in any case:
    // "each script inactive and its deployment not deployed".
    regex: /\b(?:released|not\s+deployed|undeployed|inactive)\b/i,
  },
  {
    rule: 'deployment status',
    // "testing" and "scheduled" are ordinary words, so only next to a
    // script or deployment: "the deployment is scheduled", "script in testing".
    regex:
      /\b(?:scripts?|deployments?|deployed|restlets?|suitelets?)\b[^.\n]{0,40}\b(?:testing|scheduled)\b|\b(?:testing|scheduled)\b[^.\n]{0,20}\b(?:scripts?|deployments?|restlets?|suitelets?)\b/i,
  },
];

/**
 * Scans one context file's text. Returns [{ line, rule }]. Fenced code blocks
 * are scanned too: a command in a context file can carry a fact as well.
 */
export function scanContext(text, { planLink = 'docs/platform/plan.md' } = {}) {
  const findings = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    // Markdown emphasis and code spans must not hide a fact: "123 `custbody`".
    const content = raw.replace(/[`*]/g, '');
    if (RETIRED_RULE.some(regex => regex.test(content))) {
      findings.push({ line, rule: 'retired no-write rule (superseded by L2)' });
    }
    for (const { rule, regex } of ACCOUNT_FACTS) {
      if (regex.test(content))
        findings.push({ line, rule: `hand-kept account fact: ${rule}` });
    }
  });
  if (planLink && !text.includes(planLink)) {
    findings.push({ line: 1, rule: `no link to the plan (${planLink})` });
  }
  return findings;
}

export function main(argv = process.argv.slice(2)) {
  let planLink = 'docs/platform/plan.md';
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plan-link') planLink = argv[++i];
    else files.push(argv[i]);
  }
  if (!files.length)
    files.push(...['AGENTS.md', 'CLAUDE.md'].filter(f => existsSync(f)));
  if (!files.length) {
    console.log('::error::context scan: no context file found');
    return 1;
  }
  let failed = 0;
  for (const file of files) {
    const findings = scanContext(readFileSync(resolve(file), 'utf8'), {
      planLink,
    });
    if (!findings.length) {
      console.log(`context scan: ${file} passed`);
      continue;
    }
    failed += findings.length;
    for (const { line, rule } of findings) {
      console.log(`::error file=${file},line=${line}::context scan: ${rule}`);
    }
  }
  if (failed) {
    console.log(`context scan failed: ${failed} finding(s)`);
    return 1;
  }
  console.log('context scan passed');
  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main();
}
