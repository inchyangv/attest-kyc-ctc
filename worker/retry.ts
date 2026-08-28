import { log } from './log.js';

export class Backoff {
  constructor(
    private readonly baseMs = 1_000,
    private readonly maxMs = 60_000,
    private readonly factor = 2,
  ) {}

  /** 시도 횟수(0부터)에 대한 대기 시간. 지터를 섞어 동시 재시도가 겹치지 않게 한다. */
  delayFor(attempt: number): number {
    const raw = Math.min(this.maxMs, this.baseMs * this.factor ** attempt);
    return Math.floor(raw * (0.5 + Math.random() * 0.5));
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 지수 백오프 재시도.
 *
 * ★ 존재 이유: SDK 의 `waitUntilHeightAttested()` 는 15초 간격 폴링 루프를 돌지만
 *   그 안의 HTTP 호출(10초 타임아웃)이 실패하면 예외가 루프 밖으로 튀어나온다.
 *   실측에서 8분을 기다린 뒤 API 딸꾹질 한 번에 전부 날아갔다.
 *   어테스트는 체인의 성질이지 프로세스의 성질이므로, 재시도는 언제나 안전하다.
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
      log.warn(`${label} 실패 (${i + 1}/${attempts}): ${msg} — ${d}ms 후 재시도`);
      await sleep(d);
    }
  }
  throw last;
}
