import { log } from './log.js';
import { Backoff, sleep, withRetry } from './retry.js';

/**
 * 어테스트 높이 조회.
 *
 * ★ SDK 의 `waitUntilHeightAttested()` 를 쓰지 않는다.
 *   그 함수는 15초 폴링 루프를 돌지만 내부 HTTP 호출(10초 타임아웃)이 실패하면
 *   예외가 루프 밖으로 튀어나온다 — 재시도가 없다.
 *   실측: 8분 대기 후 `AxiosError: timeout of 10000ms exceeded` 로 전량 손실.
 *   여기서는 **폴링 호출 하나하나를 재시도로 감싼다.**
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
          if (typeof body.attestedHeight !== 'number') throw new Error('attestedHeight 필드 없음');
          return body.attestedHeight;
        } finally {
          clearTimeout(timer);
        }
      },
      { attempts: 5, backoff: new Backoff(500, 10_000), signal },
    );
  }

  /**
   * 대상 높이가 어테스트될 때까지 기다린다.
   * 개별 폴링 실패는 흡수한다 — 어테스트는 체인의 성질이므로 계속 기다리면 결국 도달한다.
   */
  async waitFor(height: number, signal?: AbortSignal): Promise<void> {
    let logged = false;
    for (;;) {
      if (signal?.aborted) throw new Error('waitFor: aborted');

      let latest: number;
      try {
        latest = await this.latestAttestedHeight(signal);
      } catch (e: any) {
        // 재시도를 모두 소진해도 포기하지 않는다. 다음 폴링 주기에 다시 시도한다.
        log.warn(`어테스트 높이 조회 일시 실패, ${this.pollMs}ms 후 재시도: ${e?.message ?? e}`);
        await sleep(this.pollMs);
        continue;
      }

      if (latest >= height) {
        log.ok(`블록 ${height} 어테스트 완료 (최신 ${latest})`);
        return;
      }
      if (!logged) {
        const behind = height - latest;
        log.info(`블록 ${height} 어테스트 대기 — 현재 ${latest}, ${behind}블록 뒤 (약 ${(behind * 12 / 60).toFixed(1)}분)`);
        logged = true;
      }
      await sleep(this.pollMs);
    }
  }
}
