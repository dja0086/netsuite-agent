/**
 * Agent and trigger evals need a real agent host (a model plus the skills loaded as instructions).
 * Implement this adapter for the host you choose, then `pnpm skills:eval --mode agent|triggers` can run.
 *
 * [FILL: agent host for agent evals] e.g. the Claude Agent SDK pointed at this repo's skills folder
 * and the gateway over stdio.
 */
export interface AgentRun {
  /** Tool names called, in order. */
  toolsCalled: string[];
  /** The final answer shown to the user. */
  answer: string;
}

export interface AgentHostAdapter {
  /** Throws with setup instructions when the adapter is not configured. */
  assertConfigured(): Promise<void>;
  /** Which skill the host would load for this prompt, or null for none. */
  route(prompt: string): Promise<string | null>;
  /** Runs the prompt end to end against the sandbox gateway. */
  run(prompt: string): Promise<AgentRun>;
}

class UnconfiguredAdapter implements AgentHostAdapter {
  async assertConfigured(): Promise<void> {
    console.error(
      "No agent host adapter is configured. Implement AgentHostAdapter in scripts/eval-adapters.ts " +
        "for your agent host, then rerun. Tool evals (--mode tools) work without one.",
    );
    process.exit(2);
  }
  async route(): Promise<string | null> {
    throw new Error("not configured");
  }
  async run(): Promise<AgentRun> {
    throw new Error("not configured");
  }
}

export function agentHostAdapter(): AgentHostAdapter {
  return new UnconfiguredAdapter();
}
