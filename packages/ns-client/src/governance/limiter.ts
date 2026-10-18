import { isThrottle } from "../errors";

export interface LimiterOptions {
  /** Max in-flight requests. Must be at or below the integration's allocated concurrency limit. */
  maxConcurrency: number;
  /** Total attempts per request, including the first. Default 5. */
  attempts?: number;
  /** Base backoff in ms, doubled each retry. Default 500. */
  baseDelayMs?: number;
  /** Cap on a single backoff in ms. Default 30 000. */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface LimiterStats {
  active: number;
  queued: number;
  peakActive: number;
  completed: number;
  retries: number;
  throttled: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Caps in-flight NetSuite requests and retries only throttling rejections,
 * with exponential backoff and jitter. Every outbound call goes through one instance per process.
 */
export class GovernanceLimiter {
  private readonly max: number;
  private readonly attempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly waiting: Array<() => void> = [];
  private readonly stats: LimiterStats = { active: 0, queued: 0, peakActive: 0, completed: 0, retries: 0, throttled: 0 };

  constructor(options: LimiterOptions) {
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
      throw new Error(`maxConcurrency must be a positive integer, got ${options.maxConcurrency}`);
    }
    this.max = options.maxConcurrency;
    this.attempts = options.attempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  snapshot(): LimiterStats {
    return { ...this.stats, queued: this.waiting.length };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fn();
        } catch (error) {
          if (!isThrottle(error)) throw error;
          this.stats.throttled++;
          if (attempt >= this.attempts) throw error;
          this.stats.retries++;
          const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
          await this.sleep(backoff * (0.5 + this.random()));
        }
      }
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.stats.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      // The releasing caller handed its slot over; active was not decremented for us.
    } else {
      this.stats.active++;
    }
    this.stats.peakActive = Math.max(this.stats.peakActive, this.stats.active);
  }

  private release(): void {
    this.stats.completed++;
    const next = this.waiting.shift();
    if (next) {
      next(); // hand the slot straight to the next waiter, keeping active unchanged
    } else {
      this.stats.active--;
    }
  }
}
