/**
 * AML 계약 — **단일 정본은 `aml/types.ts` 다.**
 *
 * ★ `Methods` 와 같은 원칙: 같은 타입을 두 곳에 정의하면 언젠가 갈라진다.
 *   실제로 갈라졌었다 — 파이프라인 쪽 `MatchType` 에 `'wallet'` 이 없어서
 *   지갑 주소 대조(ONCHAIN_EXPOSURE)를 표현할 수 없었고 타입체크가 잡았다.
 *   심사 엔진이 계약의 주인이므로 그쪽을 정본으로 삼고 여기서는 재수출만 한다.
 */
export type {
  ScreeningSubject,
  ScreeningHit,
  ScreeningResult,
  ScreeningEvidence,
  ReviewReason,
  Decision,
  ListId,
  MatchType,
  AmlEngine,
} from '../aml/types.js';

import type { ScreeningResult, ScreeningSubject, AmlEngine } from '../aml/types.js';
import { Methods } from './methods.js';
import { hmacDigest } from './evidence-key.js';

/**
 * riskBand → 마크 유효기간(일). 위험이 높을수록 짧게 재검증한다.
 * 이건 발급 정책이므로 심사 엔진이 아니라 파이프라인의 책임이다.
 */
export const EXPIRY_DAYS_BY_BAND: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 365, 2: 180, 3: 90, 4: 60, 5: 30,
};

/**
 * 모의 AML 엔진 — 실물 명단 원본(`data/raw/`)이 없는 환경에서 파이프라인을 돌리기 위한 것.
 *
 * ⚠️ **실제 제재 명단을 조회하지 않는다.** 따라서 `SANCTIONS_SCREENED` 비트를 세우지 않는다 —
 *    세우면 거짓말이다(§4.2 · §15-4). 비트가 0이면 소비자 정책이 자동으로 거르므로,
 *    **모의 엔진으로 발급한 마크는 제재 스크리닝을 요구하는 게이트를 열지 못한다.**
 *    이것이 의도한 동작이다. 실물은 `aml/engine.ts` 의 `ListBackedAmlEngine`.
 */
export class MockAmlEngine implements AmlEngine {
  readonly engineVersion = 'mock-0.1.0';
  private readonly evidenceKey: string;
  private readonly keyId: string;

  /**
   * @param opts.evidenceKey 증적 가명화 키. **기본값 없음** — 실물 엔진과 같은 원칙이다.
   *        모의 엔진만 무염 해시를 쓰면, 증적이 보호된 것처럼 보이지만 아닌 상태가 생긴다.
   */
  constructor(opts: { evidenceKey: string; keyId?: string }) {
    if (!opts?.evidenceKey) throw new Error('MockAmlEngine: evidenceKey 는 필수입니다');
    this.evidenceKey = opts.evidenceKey;
    this.keyId = opts.keyId ?? 'mock-k1';
  }

  async screen(subject: ScreeningSubject): Promise<ScreeningResult> {
    const highRisk = ['KP', 'IR', 'SY', 'CU'];
    const isHighRisk = highRisk.includes(subject.residence) || highRisk.includes(subject.nationality);
    const screenedAt = Date.now();

    return {
      decision: isHighRisk ? 'BLOCK' : 'ALLOW',
      riskBand: isHighRisk ? 5 : 2,
      hits: [],
      // 관할 확인만 실제로 수행했다 → 그 비트만 세운다
      methodsApplied: Methods.JURISDICTION_CHECK,
      listVersions: {},
      engineVersion: this.engineVersion,
      screenedAt,
      evidence: {
        engineVersion: this.engineVersion,
        listVersions: {},
        // ⚠️ 이름 원문이 아니라 **키드 HMAC** 을 넣는다.
        //    ① 증적에 PII 를 넣으면 삭제권(PIPA/GDPR)과 감사추적이 충돌한다 —
        //       금고에서 원문을 지우는 순간 evidenceHash 를 재계산할 수 없게 된다.
        //    ② 무염 해시로는 부족하다 — 이름은 엔트로피가 낮아 사전공격에 뚫린다.
        //    자세한 근거는 evidence-key.ts 주석 참조.
        keyId: this.keyId,
        nameDigest: hmacDigest(this.evidenceKey, subject.fullName),
        tokenDigests: [],
        variantDigests: [],
        checks: [
          { id: 'jurisdiction', applied: true, passed: !isHighRisk },
          { id: 'sanctions_list', applied: false, passed: false,
            note: '모의 엔진 — 실제 명단 미조회. SANCTIONS_SCREENED 비트 미설정' },
          { id: 'onchain_exposure', applied: false, passed: false, note: '모의 엔진 — 제재 지갑 목록 미조회' },
        ],
        hitDigests: [],
      },
    };
  }

  async listVersions(): Promise<Record<string, number>> {
    return {};
  }
}
