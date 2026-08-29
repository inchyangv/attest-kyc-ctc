/**
 * AmlEngine implementation, screening against the three real lists.
 *
 * Decision rules. Escalation is unconditional; nothing softens a hit.
 *   wallet hit, or a corroborated name hit   -> BLOCK  (band 5)
 *   high-scoring name hit, no corroboration  -> REVIEW (band 4), a human looks
 *   FATF call-for-action jurisdiction        -> REVIEW (band 4)
 *   FATF increased-monitoring jurisdiction   -> ALLOW  (band 3)
 *   no date of birth                         -> REVIEW
 *   otherwise                                -> ALLOW  (band 1)
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
  /** Evidence key. Required, because names carry too little entropy for an unsalted hash
   *  to protect. No default: a default is what someone ships to production. */
  evidenceKey: string;
  /** Key identifier, so rotation stays traceable. */
  keyId?: string;
  /** With no PEP or adverse-media data, those bits stay unset. Defaults to false. */
  hasPepData?: boolean;
  hasAdverseMedia?: boolean;
}

export class ListBackedAmlEngine implements AmlEngine {
  private corpus: Corpus;
  private versions: Record<string, number>;
  private opts: EngineOptions;

  constructor(opts: EngineOptions) {
    if (!opts.evidenceKey) throw new Error('evidenceKey is required. It is the HMAC key that keeps names out of the evidence.');
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

    // Decision
    const blocking = hits.filter(h => h.corroborated && (h.matchType === 'wallet' || h.score >= 0.88));
    // An uncorroborated romanised hit does not move the decision.
    // Expansion is our inference, not something the list says. Holding people on it catches
    // ordinary Korean names in bulk, as the evaluation showed. The hit still lands in evidence.
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

    // Set a bit only for screening that actually ran
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
        { id: 'jurisdiction.fatf',  applied: true,  passed: jr.level === 0, note: FATF.verified ? jr.reason : `unverified table (${FATF.asOf}) ${jr.reason}`.trim() },
        { id: 'identity.dob',       applied: true,  passed: !!dob },
        { id: 'pep',                applied: !!this.opts.hasPepData,      passed: true, note: this.opts.hasPepData ? undefined : 'no data source connected, bit left unset' },
        { id: 'adverseMedia',       applied: !!this.opts.hasAdverseMedia, passed: true, note: this.opts.hasAdverseMedia ? undefined : 'no data source connected, bit left unset' },
      ],
      hitDigests: hits.map(h => `${h.listId}:${h.entryId}:${h.matchType}:${h.score.toFixed(3)}:${h.corroborated ? 'c' : 'u'}`).sort(),
    };

    return {
      decision, reviewReason, riskBand: band, hits, methodsApplied,
      listVersions: { ...this.versions }, engineVersion: ENGINE_VERSION, screenedAt, evidence,
    };
  }
}

/** An auditor recomputes this from their copy, so serialisation sorts keys and stays fixed. */
export function evidenceDigest(e: ScreeningEvidence): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map(k => [k, canon((v as any)[k])]))
      : v;
  return '0x' + createHash('sha256').update(JSON.stringify(canon(e))).digest('hex');
}
