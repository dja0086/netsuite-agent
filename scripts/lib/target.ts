/**
 * Live tests (evals, load test, contract recording, release:check) run real calls against NS_ACCOUNT_ID.
 * They must only ever hit a sandbox or a demo account. NS_TARGET_KIND says which; production is refused.
 */
export type TargetKind = "sandbox" | "demo";

export function requireLiveTarget(script: string, env: NodeJS.ProcessEnv = process.env): TargetKind {
  const kind = env.NS_TARGET_KIND?.trim().toLowerCase();
  if (kind === "sandbox" || kind === "demo") return kind;
  const why =
    kind === "production"
      ? "NS_TARGET_KIND=production: live tests never run against a real production account."
      : `NS_TARGET_KIND is ${kind ? `"${kind}"` : "not set"}.`;
  console.error(
    `${script}: refusing to run. ${why}\n` +
      "Set NS_TARGET_KIND=sandbox for a sandbox, or NS_TARGET_KIND=demo for a demo/test-drive account holding no real data.",
  );
  process.exit(2);
}
