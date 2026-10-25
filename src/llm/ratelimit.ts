import { setTimeout as sleep } from "node:timers/promises";
import { ProviderError } from "./types.js";

/** Minimal requests-per-minute limiter (sliding window). */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(private readonly requestsPerMinute?: number) {}

  async acquire(): Promise<void> {
    if (!this.requestsPerMinute) return;
    for (;;) {
      const now = Date.now();
      while (this.stamps.length && now - this.stamps[0]! >= 60_000) this.stamps.shift();
      if (this.stamps.length < this.requestsPerMinute) {
        this.stamps.push(now);
        return;
      }
      await sleep(60_000 - (now - this.stamps[0]!) + 25);
    }
  }
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** Retry transient provider failures with exponential backoff, honouring Retry-After. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = { retries: 6, baseDelayMs: 2_000, maxDelayMs: 90_000 }): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : undefined;
      const cause = (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
      const networkError = cause === "ECONNRESET" || cause === "ETIMEDOUT" || cause === "UND_ERR_SOCKET";
      if (attempt >= opts.retries || !(networkError || (status !== undefined && RETRYABLE.has(status)))) throw err;
      const hinted = err instanceof ProviderError ? err.retryAfterMs : undefined;
      const delay = Math.min(opts.maxDelayMs, hinted ?? opts.baseDelayMs * 2 ** attempt);
      attempt += 1;
      await sleep(delay);
    }
  }
}
