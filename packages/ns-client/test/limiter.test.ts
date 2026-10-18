import { describe, expect, it } from "vitest";
import { GovernanceLimiter, NsHttpError } from "../src";

const throttle = () => new NsHttpError(429, undefined, "Too many requests");
const tick = () => new Promise((r) => setTimeout(r, 1));

describe("GovernanceLimiter", () => {
  it("never exceeds maxConcurrency", async () => {
    const limiter = new GovernanceLimiter({ maxConcurrency: 3 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await tick();
          active--;
        }),
      ),
    );
    expect(peak).toBe(3);
    expect(limiter.snapshot()).toMatchObject({ active: 0, queued: 0, completed: 20, peakActive: 3 });
  });

  it("retries throttling errors with growing backoff, then succeeds", async () => {
    const delays: number[] = [];
    const limiter = new GovernanceLimiter({
      maxConcurrency: 1,
      sleep: async (ms) => void delays.push(ms),
      random: () => 0.5, // jitter factor exactly 1
    });
    let calls = 0;
    const result = await limiter.run(async () => {
      calls++;
      if (calls < 3) throw throttle();
      return "ok";
    });
    expect(result).toBe("ok");
    expect(delays).toEqual([500, 1000]);
    expect(limiter.snapshot()).toMatchObject({ retries: 2, throttled: 2 });
  });

  it("treats SSS_REQUEST_LIMIT_EXCEEDED from a RESTlet as a throttle", async () => {
    const limiter = new GovernanceLimiter({ maxConcurrency: 1, sleep: async () => {} });
    let calls = 0;
    await limiter.run(async () => {
      if (calls++ === 0) throw new NsHttpError(400, "SSS_REQUEST_LIMIT_EXCEEDED", "limit");
    });
    expect(calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const limiter = new GovernanceLimiter({ maxConcurrency: 1, sleep: async () => {} });
    let calls = 0;
    await expect(
      limiter.run(async () => {
        calls++;
        throw new NsHttpError(400, "INVALID_PARAMETER", "bad");
      }),
    ).rejects.toThrow("bad");
    expect(calls).toBe(1);
  });

  it("gives up after the configured attempts and frees the slot", async () => {
    const limiter = new GovernanceLimiter({ maxConcurrency: 1, attempts: 3, sleep: async () => {} });
    let calls = 0;
    await expect(
      limiter.run(async () => {
        calls++;
        throw throttle();
      }),
    ).rejects.toBeInstanceOf(NsHttpError);
    expect(calls).toBe(3);
    await expect(limiter.run(async () => "next")).resolves.toBe("next");
  });

  it("rejects a non-positive concurrency", () => {
    expect(() => new GovernanceLimiter({ maxConcurrency: 0 })).toThrow();
  });
});
