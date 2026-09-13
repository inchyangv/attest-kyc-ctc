import { log } from './log.js';
import { setTimeout as delay } from 'node:timers/promises';

export class WorkerStoppedError extends Error { constructor() { super('WORKER_STOPPED'); } }
export function throwIfStopped(signal?: AbortSignal): void { if (signal?.aborted) throw new WorkerStoppedError(); }

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

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfStopped(signal);
  try { await delay(ms, undefined, { signal }); }
  catch (error) { throwIfStopped(signal); throw error; }
}

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
    throwIfStopped(opts.signal);
    try {
      const result = await fn(); throwIfStopped(opts.signal); return result;
    } catch (e: any) {
      throwIfStopped(opts.signal);
      last = e;
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      if (i === attempts - 1) break;
      const d = backoff.delayFor(i);
      log.warn(`${label} failed (${i + 1}/${attempts}): ${msg}. Retrying in ${d}ms.`);
      await sleep(d, opts.signal);
    }
  }
  throw last;
}
