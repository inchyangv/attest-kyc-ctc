import { log } from './log.js';

export class Backoff {
  constructor(
    private readonly baseMs = 1_000,
    private readonly maxMs = 60_000,
    private readonly factor = 2,
  ) {}

  /** Delay for attempt n, counting from 0. Jitter keeps concurrent retries from colliding. */
  delayFor(attempt: number): number {
    const raw = Math.min(this.maxMs, this.baseMs * this.factor ** attempt);
    return Math.floor(raw * (0.5 + Math.random() * 0.5));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retry with exponential backoff.
 *
 * Why this exists: the SDK's `waitUntilHeightAttested()` polls every 15 seconds, but when the
 * escapes the loop. There is no retry.
 * We measured it: eight minutes of waiting lost to one API hiccup.
 * Attestation belongs to the chain, not to our process, so retrying is always safe.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { attempts?: number; backoff?: Backoff; signal?: AbortSignal } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 6;
  const backoff = opts.backoff ?? new Backoff();
  let last: unknown;

  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new Error(`${label}: aborted`);
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      if (i === attempts - 1) break;
      const d = backoff.delayFor(i);
      log.warn(`${label} failed (${i + 1}/${attempts}): ${msg}. Retrying in ${d}ms.`);
      await sleep(d);
    }
  }
  throw last;
}
