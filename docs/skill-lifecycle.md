# Skill lifecycle

A skill ships only when its evals pass in CI and its owners approve. Every later change goes through the same gate with evidence. Nobody edits a skill directly on main.

## Anatomy

```
skills/<name>/
├── SKILL.md            # frontmatter + instructions the agent reads
├── evals/
│   ├── triggers.yaml   # prompts that SHOULD and SHOULD NOT route here
│   └── tasks.yaml      # tool cases (sandbox) and agent cases (rubric)
├── examples/           # worked conversations, synthetic data only
├── CHANGELOG.md
└── OWNERS              # skill owner + backup reviewer
```

The frontmatter schema is `SkillManifest` in `packages/schemas`. The agent host reads `name` and `description`; the gateway and CI read `version`, `tools`, `disabled_tools`, `writes`, `enabled`, `platform`, `deprecated` and `governance_budget`.

## What enforces what

| Rule | Enforced by | When |
| --- | --- | --- |
| Frontmatter valid, folder name matches | `skills:validate`, gateway start-up | Always |
| Declared tools exist; write tools only on `writes: true` skills | `skills:validate`, gateway start-up | Always |
| Only declared tools are served | Gateway (`createGateway`) | Runtime |
| Each write tool has an eval proving it is blocked without approval | `skills:validate` | Enabled skills |
| ≥ 5 should-route and ≥ 3 should-not-route prompts; no prompt claimed by two skills | `skills:validate` | Enabled skills (overlap: always) |
| ≥ 3 task cases; tool cases call only declared tools | `skills:validate` | Enabled skills (tool scope: always) |
| OWNERS, CHANGELOG entry for the version, CODEOWNERS line, ≥ 3 examples, no `[FILL]` | `skills:validate` | Enabled skills |
| No keys, tokens, secrets or real account hostnames in the folder | `skills:validate` + gitleaks | Always |
| Tool cases pass on the sandbox; safety cases 100% | `skills:eval --mode tools` (`skills-eval.yml`) | PRs touching skills or tools |
| Trigger precision | `skills:eval --mode triggers` (a `release:check` gate) | Every release |
| Agent cases (rubric) | `skills:eval --mode agent` through the `claude` CLI (docs/agent-evals.md) | Skill changes that affect behaviour; about $10 per full run |

Skills with `enabled: false` are under construction: rule failures are warnings, except tool existence, tool scope, prompt overlap and secrets, which are always errors.

A platform skill is always served, so a new tool on one ships disabled by listing it in both `tools` and `disabled_tools`: the gateway does not serve it, tool evals still run it. Release it by removing it from `disabled_tools` (minor version).

## Acceptance thresholds (starting points)

| Criterion | Threshold |
| --- | --- |
| Trigger precision | ≥ 95% of should-route prompts route here; ≤ 3% of other skills' prompts do |
| Task success | ≥ 90% of task cases pass on the sandbox (`--threshold 0.9`) |
| Write safety | 100% of safety cases pass |
| Governance | Within declared budget; zero unhandled throttle errors |

[FILL: agreed thresholds]

## Improving a skill

1. Reproduce first: add the failing prompt or case to `evals/`; it must fail on main.
2. Change `SKILL.md`, examples or the tool, never the eval to make it pass.
3. Bump the version: patch (wording/examples), minor (new tool, record type or cases), major (changes triggers, removes a capability, or changes what is written).
4. Add a CHANGELOG entry for the new version.
5. Attach before/after eval results to the PR.
6. Merge rules: patch, owner; minor, owner + reviewer; major, owner + NetSuite admin + sandbox canary of [FILL] days.

A PR that lowers another skill's trigger precision or task success by more than 2 points is blocked.

## Adding a skill

1. Open a proposal issue: problem, users, ≥ 10 example prompts, tools, NetSuite surface, writes, governance estimate, data exposure.
2. Overlap check against existing trigger evals; extend an existing skill if one already covers most prompts.
3. `pnpm new:skill <name> [--writes]` (creates the folder disabled, a tool module, a CODEOWNERS line).
4. Write `evals/triggers.yaml` and `evals/tasks.yaml` first.
5. Write `SKILL.md` and three examples; build the tools; NetSuite-side code goes in `netsuite/` via SDF.
6. Pilot on the sandbox with `enabled: false` (tool evals still run).
7. Accept: validator clean with `enabled: true`, tool evals pass, owners approve; release 1.0.0.
8. Promote to production through change-control.

Write tools start behind dry-run: the first release exposes plan and dry-run tools only.

## Retiring a skill

Set `deprecated: true` and `replacement: <skill>`. The validator reports it; remove the folder after [FILL] days with no calls in the audit log.
