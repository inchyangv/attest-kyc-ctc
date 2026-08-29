import { log } from './log.js';
import { Backoff, sleep, withRetry } from './retry.js';

/**
 * Attested-height polling.
 *
 * We do not use the SDK's `waitUntilHeightAttested()`.
 * It polls every 15 seconds, but when the inner HTTP call (10s timeout) fails the exception
 * escapes the loop. There is no retry.
 * Measured: eight minutes of waiting lost to a single `AxiosError: timeout of 10000ms exceeded`.
 * Here every individual poll is wrapped in a retry.
 */
export class AttestationWatcher {
  constructor(
    private readonly proofBuilderUrl: string,
    private readonly chainKey: number,
    private readonly pollMs = 15_000,
  ) {}

  async latestAttestedHeight(signal?: AbortSignal): Promise<number> {
    return withRetry(
      `attested-height(chainKey=${this.chainKey})`,
      async () => {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 15_000);
        try {
          const res = await fetch(
            `${this.proofBuilderUrl}/api/v1/attested-height/${this.chainKey}`,
            { signal: ctl.signal },
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { attestedHeight: number };
          if (typeof body.attestedHeight !== 'number') throw new Error('attestedHeight field missing');
          return body.attestedHeight;
        } finally {
          clearTimeout(timer);
        }
      },
      { attempts: 5, backoff: new Backoff(500, 10_000), signal },
    );
  }

  /**
   * Waits until the target height is attested.
   * Individual poll failures are absorbed. Attestation is a property of the chain, so waiting works.
   */
  async waitFor(height: number, signal?: AbortSignal): Promise<void> {
    let logged = false;
    for (;;) {
      if (signal?.aborted) throw new Error('waitFor: aborted');

      let latest: number;
      try {
        latest = await this.latestAttestedHeight(signal);
      } catch (e: any) {
        // Exhausting the retries is not giving up. The next poll cycle tries again.
        log.warn(`attested-height poll failed, retrying in ${this.pollMs}ms: ${e?.message ?? e}`);
        await sleep(this.pollMs);
        continue;
      }

      if (latest >= height) {
        log.ok(`block ${height} attested (latest ${latest})`);
        return;
      }
      if (!logged) {
        const behind = height - latest;
        log.info(`waiting for block ${height} to be attested. Latest ${latest}, ${behind} blocks behind (~${(behind * 12 / 60).toFixed(1)} min)`);
        logged = true;
      }
      await sleep(this.pollMs);
    }
  }
}
