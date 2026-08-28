/**
 * AML 심사 엔진 — 공개 계약.
 * 발급 파이프라인(docs/07)이 이 인터페이스만 보고 호출한다.
 */

export interface ScreeningSubject {
  fullName: string;
  romanizedName?: string;      // 없으면 엔진이 전개한다
  dateOfBirth: string;         // YYYY-MM-DD
  nationality: string;         // ISO-3166 alpha-2
  residence: string;           // ISO-3166 alpha-2
  walletAddress: string;
}

export type ListId = 'OFAC_SDN' | 'UN_CONSOLIDATED' | 'EU_FSF';
export type MatchType = 'exact' | 'fuzzy' | 'alias' | 'romanized' | 'wallet';

export interface ScreeningHit {
  listId: ListId;
  listVersion: number;         // 원본 파일 내용 해시의 앞 8바이트 → 판본 식별
  entryId: string;
  matchedName: string;
  score: number;               // 0..1
  matchType: MatchType;
  /** 이 적중이 단독으로 차단을 정당화하는가.
   *  로마자 전개는 우리가 만든 추론이므로 뒷받침(생년월일·국가) 없이는 false. */
  corroborated: boolean;
  corroboration?: ('dob' | 'nationality' | 'wallet')[];
}

export type Decision = 'ALLOW' | 'BLOCK' | 'REVIEW';
export type ReviewReason =
  | 'NAME_SIMILARITY' | 'DOB_MISSING' | 'HIGH_RISK_JURISDICTION'
  | 'ONCHAIN_EXPOSURE' | 'MANUAL_FLAG';

export interface ScreeningResult {
  decision: Decision;
  reviewReason?: ReviewReason;
  riskBand: 1 | 2 | 3 | 4 | 5;   // 1=최저 → expiry 365일 … 5=최고 → 30일
  hits: ScreeningHit[];
  methodsApplied: number;        // 실제로 수행한 심사만 비트를 세운다
  listVersions: Record<string, number>;
  engineVersion: string;         // 정규화·매칭 규칙 판본 — 증적 재현성의 나머지 절반
  screenedAt: number;
  evidence: ScreeningEvidence;
}

/**
 * 결정적이어야 한다. 감사인이 사본으로 evidenceHash 를 재계산해 대조한다.
 *
 * ⚠️ **이름 원문을 담지 않는다.** 증적은 영구 보관하고 금고는 삭제권에 따라 지워야 하는데,
 * 증적에 PII 가 있으면 둘이 충돌한다 — 금고를 지우는 순간 증적도 지워야 하고 감사추적이 사라진다.
 *
 * ⚠️ **가명화이지 익명화가 아니다.** 이름은 엔트로피가 낮아 무염 해시는 사전공격에 뚫린다.
 * 그래서 발급사가 보유한 **증적 키로 HMAC** 한다. 키 보유자는 후보 대조로 원문을 확인할 수 있고,
 * 그것이 의도다(감사 재현성). 키 없이는 다이제스트에서 이름을 얻지 못한다.
 */
export interface ScreeningEvidence {
  engineVersion: string;
  listVersions: Record<string, number>;
  keyId: string;              // 어느 증적 키로 만들었는가 (로테이션 추적)
  nameDigest: string;         // HMAC(key, 정규화된 이름)
  tokenDigests: string[];     // 토큰별 HMAC — 매칭 재현성 유지
  variantDigests: string[];   // 로마자 전개별 HMAC
  checks: { id: string; applied: boolean; passed: boolean; note?: string }[];
  hitDigests: string[];          // listId:entryId:matchType:score(3자리)
}

export interface AmlEngine {
  screen(subject: ScreeningSubject): Promise<ScreeningResult>;
  listVersions(): Promise<Record<string, number>>;
}

/** methods 비트는 재정의하지 않는다 — 중복 정의가 있으면 언젠가 갈라진다.
 *  정본은 `pipeline/methods.ts` 이고 그것은 `ProofmarkTypes.sol` 과 테스트로 묶여 있다. */
export { Methods as M } from '../pipeline/methods.js';

/** 위험등급 → 어테스테이션 만료(일). 기획안 §6.2 */
export const BAND_TO_DAYS: Record<number, number> = { 1: 365, 2: 180, 3: 90, 4: 60, 5: 30 };
