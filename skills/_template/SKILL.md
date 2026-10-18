---
name: {{name}}
description: "[FILL: one or two sentences. Say what the skill does AND when to use it, then what it is NOT for, naming the skill to use instead.]"
version: 0.1.0
owner: "@[FILL:owner]"
# Tools this skill may call. Each must exist in apps/mcp-gateway/src/tools/ (see {{name}}.ts).
tools: []
writes: {{writes}}
# New skills ship disabled. Set to true only when the acceptance table passes (see docs/skill-lifecycle.md).
enabled: false
governance_budget:
  max_calls_per_invocation: 20
  max_concurrency: 2
---

# {{title}}

[FILL: one paragraph on what this skill is for.]

## When to use

- [FILL: the requests that belong here]

Hand off instead when: [FILL: name the neighbouring skills and when they win].

## How to work

1. [FILL: the steps the agent follows, naming each tool]

## Approval and safety

[FILL: for write-capable skills, what needs approval and what the dry-run shows. Write tools start behind dry-run: the first release exposes plan and dry-run tools only.]

## Do not

- [FILL]
