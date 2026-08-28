/**
 * AmlEngine 구현. 실제 명단 3종으로 심사한다.
 *
 * 판정 규칙 — 격상은 무조건, 완화는 없다:
 *   지갑 적중 또는 뒷받침된 이름 적중        → BLOCK (밴드 5)
 *   뒷받침 없는 고득점 이름 적중             → REVIEW (밴드 4) — 사람이 본다
 *   FATF 대응조치 관할                       → REVIEW (밴드 4)
 *   FATF 강화 모니터링 관할                  → ALLOW  (밴드 3)
 *   생년월일 없음                            → REVIEW
 *   그 외                                    → ALLOW  (밴드 1)
 */
import { createHash, createHmac } from 'node:crypto';
import { ENGINE_VERSION, normalizeName, normalizeDob, tokenize, contentTokens, normalizeCountry } from './normalize.js';
import { romanizeVariants, hasHangul } from './romanize.js';
import { buildCorpus, screenNames, type Corpus } from './match.js';
import { jurisdictionRisk, FATF } from './jurisdiction.js';
import type { SanctionEntry } from './ingest/parse.js';
import {
  M, type AmlEngine, type ScreeningSubject, type ScreeningResult,
  type ScreeningEvidence, type Decision, type ReviewReason, type ScreeningHit,
} from './types.js';

export interface EngineOptions {
  entries: SanctionEntry[];
  listVersions: Record<string, number>;
  /** 증적 키. **필수** — 이름은 엔트로피가 낮아 무염 해시로는 보호되지 않는다.
   *  기본값을 두지 않는 이유: 기본값이 있으면 누군가 그대로 배포한다. */
  evidenceKey: string;
  /** 키 식별자. 로테이션 시 어느 키로 만든 증적인지 구분한다. */
  keyId?: string;
  /** PEP·adverse media 데이터가 없으면 그 비트를 세우지 않는다 (기본 false) */
  hasPepData?: boolean;
  hasAdverseMedia?: boolean;
}

export class ListBackedAmlEngine implements AmlEngine {
  private corpus: Corpus;
  private versions: Record<string, number>;
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    if (!opts.evidenceKey) throw new Error('evidenceKey 가 필요하다 — 증적에 이름 원문을 남기지 않기 위한 HMAC 키');
    this.opts = opts;
    this.corpus = buildCorpus(opts.entries);
    this.versions = opts.listVersions;
  }

  async listVersions() { return { ...this.versions }; }

  async screen(subject: ScreeningSubject): Promise<ScreeningResult> {
    const screenedAt = Math.floor(Date.now() / 1000);
    const dob = normalizeDob(subject.dateOfBirth);
    const nat = normalizeCountry(subject.nationality);
    const res = normalizeCountry(subject.residence);

    const hits = screenNames(this.corpus, {
      fullName: subject.fullName, romanizedName: subject.romanizedName,
      dob, nationality: nat, walletAddress: subject.walletAddress,
    }).map(h => ({ ...h, listVersion: this.versions[h.listId] ?? 0 }));

    // ── 판정 ──
    const blocking = hits.filter(h => h.corroborated && (h.matchType === 'wallet' || h.score >= 0.88));
    // 뒷받침 없는 **로마자 전개** 적중은 판정을 움직이지 않는다.
    // 전개 표기는 우리가 만든 추론이지 명단에 실린 사실이 아니다 — 이걸로 사람을 붙잡으면
    // 흔한 한국 이름이 무더기로 걸린다(평가에서 실측됨). 적중은 증적에 그대로 남는다.
    const drivesDecision = (h: ScreeningHit) =>
      h.matchType !== 'romanized' || h.corroborated;
    const suspicious = hits.filter(h => !blocking.includes(h) && h.score >= 0.82 && drivesDecision(h));
    const jr = [jurisdictionRisk(nat), jurisdictionRisk(res)].sort((a, b) => b.level - a.level)[0];

    let decision: Decision = 'ALLOW';
    let reviewReason: ReviewReason | undefined;
    let band: 1 | 2 | 3 | 4 | 5 = 1;

    if (blocking.length) {
      decision = 'BLOCK'; band = 5;
    } else if (suspicious.length) {
      decision = 'REVIEW'; reviewReason = 'NAME_SIMILARITY'; band = 4;
    } else if (jr.level === 2) {
      decision = 'REVIEW'; reviewReason = 'HIGH_RISK_JURISDICTION'; band = 4;
    } else if (!dob) {
      decision = 'REVIEW'; reviewReason = 'DOB_MISSING'; band = 3;
    } else if (jr.level === 1) {
      decision = 'ALLOW'; band = 3;
    } else {
      decision = 'ALLOW'; band = hits.length ? 2 : 1;
    }

    // ── 실제로 수행한 심사만 비트를 세운다 ──
    let methodsApplied = M.SANCTIONS_SCREENED | M.JURISDICTION_CHECK | M.ONCHAIN_EXPOSURE;
    if (this.opts.hasPepData) methodsApplied |= M.PEP_SCREENED;
    if (this.opts.hasAdverseMedia) methodsApplied |= M.ADVERSE_MEDIA;

    const norm = normalizeName(subject.romanizedName || subject.fullName);
    const toks = contentTokens(tokenize(norm));
    const variants = hasHangul(subject.fullName) ? romanizeVariants(subject.fullName).sort() : [];
    const hmac = (v: string) => '0x' + createHmac('sha256', this.opts.evidenceKey).update(v.normalize('NFC')).digest('hex').slice(0, 32);
    const keyId = this.opts.keyId ?? 'default';

    const evidence: ScreeningEvidence = {
      engineVersion: ENGINE_VERSION,
      listVersions: { ...this.versions },
      keyId,
      nameDigest: hmac(norm),
      tokenDigests: toks.map(hmac),
      variantDigests: variants.map(hmac),
      checks: [
        { id: 'sanctions.name',     applied: true,  passed: blocking.length === 0, note: `${hits.length} candidate hit(s)` },
        { id: 'sanctions.wallet',   applied: true,  passed: !hits.some(h => h.matchType === 'wallet') },
        { id: 'jurisdiction.fatf',  applied: true,  passed: jr.level === 0, note: FATF.verified ? jr.reason : `미검증 표(${FATF.asOf}) ${jr.reason}`.trim() },
        { id: 'identity.dob',       applied: true,  passed: !!dob },
        { id: 'pep',                applied: !!this.opts.hasPepData,      passed: true, note: this.opts.hasPepData ? undefined : '데이터 미연동 — 비트 미설정' },
        { id: 'adverseMedia',       applied: !!this.opts.hasAdverseMedia, passed: true, note: this.opts.hasAdverseMedia ? undefined : '데이터 미연동 — 비트 미설정' },
      ],
      hitDigests: hits.map(h => `${h.listId}:${h.entryId}:${h.matchType}:${h.score.toFixed(3)}:${h.corroborated ? 'c' : 'u'}`).sort(),
    };

    return {
      decision, reviewReason, riskBand: band, hits, methodsApplied,
      listVersions: { ...this.versions }, engineVersion: ENGINE_VERSION, screenedAt, evidence,
    };
  }
}

/** 증적 사본으로 재계산해 대조할 수 있어야 한다 — 키 정렬 고정 직렬화 */
export function evidenceDigest(e: ScreeningEvidence): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as any)[k])]))
      : v;
  return '0x' + createHash('sha256').update(JSON.stringify(canon(e))).digest('hex');
}
