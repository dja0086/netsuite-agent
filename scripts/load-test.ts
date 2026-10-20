/**
 * pnpm load:test [--requests 40] [--report file]
 * Fires many cheap read-only SuiteQL calls at once through ONE ns-client (one limiter), the way a busy
 * agent would. Passes when the limiter never exceeds NS_MAX_CONCURRENCY and no request fails unhandled.
 */
import { writeFile } from "node:fs/promises";
import { NsClient, NsHttpError, suiteql } from "@ns-agent/ns-client";
import { requireLiveTarget } from "./lib/target";

const target = requireLiveTarget("load:test");
const flag = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const total = Number(flag("requests", "40"));
const reportFile = process.argv.includes("--report") ? flag("report", "") : undefined;

const ns = NsClient.fromEnv();
const max = ns.config.maxConcurrency;
const latencies: number[] = [];
const failures: string[] = [];

console.log(`Load test: ${total} requests, NS_MAX_CONCURRENCY=${max}, target=${target} (${ns.config.accountId})`);
const started = Date.now();

await Promise.all(
  Array.from({ length: total }, async (_, i) => {
    const t0 = Date.now();
    try {
      await suiteql(ns, `SELECT COUNT(id) AS n FROM customer WHERE id > ${i}`, { limit: 1 });
      latencies.push(Date.now() - t0);
    } catch (error) {
      failures.push(error instanceof NsHttpError ? `HTTP ${error.status} ${error.code ?? ""}`.trim() : String(error));
    }
  }),
);

const wallMs = Date.now() - started;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const stats = ns.limiter.snapshot();
const pass = failures.length === 0 && stats.peakActive <= max;

const report = {
  target,
  accountId: ns.config.accountId,
  requests: total,
  maxConcurrency: max,
  peakActive: stats.peakActive,
  succeeded: latencies.length,
  failed: failures.length,
  failures: [...new Set(failures)],
  throttledThenRetried: stats.throttled,
  retries: stats.retries,
  latencyMs: { p50: pct(50), p95: pct(95), max: sorted.at(-1) ?? 0 },
  wallMs,
  pass,
};
console.log(JSON.stringify(report, null, 2));
if (reportFile) await writeFile(reportFile, JSON.stringify(report, null, 2));
process.exit(pass ? 0 : 1);
