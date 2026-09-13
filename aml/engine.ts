/**
 * AmlEngine implementation, screening against the three real lists.
 *
 * Decision rules. Escalation is unconditional; nothing softens a hit.
 *   wallet hit, or strong name + full DOB without conflict -> BLOCK (band 5)
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
import { identityConflicts } from './identity.js';
import { assertJurisdictionTable, jurisdictionRisk, FATF } from './jurisdiction.js';
import { assertProvenance, freshnessHours, listVersionsOf, LIST_IDS, type ListProvenance } from './provenance.js';
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
  /** Deprecated capability flags. true is rejected: neither screening is implemented here. */
  hasPepData?: boolean;
  hasAdverseMedia?: boolean;
  /** Mandatory at file-backed runtime entry points; omitted only for synthetic/offline fixtures. */
  provenance?: ListProvenance;
  /** Bound at construction so a held engine cannot silently use a looser runtime purpose. */
  maxAgeHours?: number;
}

export class ListBackedAmlEngine implements AmlEngine {
  private corpus: Corpus;
  private versions: Record<string, number>;
  private opts: Pick<EngineOptions, 'evidenceKey' | 'keyId' | 'provenance'> & { maxAgeHours: number };

  constructor(opts: EngineOptions) {
    if (!opts.evidenceKey) throw new Error('evidenceKey is required. It is the HMAC key that keeps names out of the evidence.');
    if (opts.hasPepData || opts.hasAdverseMedia) throw new Error('PEP/adverse-media screening is not implemented; data flags cannot enable it');
    this.opts = { evidenceKey: opts.evidenceKey, keyId: opts.keyId, provenance: opts.provenance ? structuredClone(opts.provenance) : undefined,
      maxAgeHours: opts.maxAgeHours ?? freshnessHours() };
    if (this.opts.provenance) {
      assertProvenance(this.opts.provenance, Date.now(), this.opts.maxAgeHours);
      const versions = listVersionsOf(this.opts.provenance);
      if (Object.keys(opts.listVersions).sort().join() !== [...LIST_IDS].sort().join() ||
        LIST_IDS.some(id => versions[id] !== opts.listVersions[id] || opts.entries.filter(e => e.listId === id).length !== this.opts.provenance!.sources[id].entryCount) ||
        opts.entries.some(e => !LIST_IDS.includes(e.listId))) throw new Error('engine corpus/provenance mismatch');
    }
    this.corpus = buildCorpus(structuredClone(opts.entries));
    this.versions = { ...opts.listVersions };
  }

  async listVersions() {
    if (this.opts.provenance) assertProvenance(this.opts.provenance, Date.now(), this.opts.maxAgeHours);
    return { ...this.versions };
  }

  async screen(subject: ScreeningSubject): Promise<ScreeningResult> {
    if (this.opts.provenance) assertProvenance(this.opts.provenance, Date.now(), this.opts.maxAgeHours);
    assertJurisdictionTable(FATF);
    const screenedAt = Math.floor(Date.now() / 1000);
    const dob = normalizeDob(subject.dateOfBirth);
    const nat = normalizeCountry(subject.nationality);
    const res = normalizeCountry(subject.residence);
    const nameAvailable = this.corpus.names.length > 0;
    const nameApplied = nameAvailable && contentTokens(tokenize(normalizeName(subject.fullName))).length > 0;
    const walletApplied = this.corpus.byWallet.size > 0 && /^0x[0-9a-fA-F]{40}$/.test(subject.walletAddress ?? '');
    const jurisdictionApplied = /^[A-Z]{2}$/.test(nat) && /^[A-Z]{2}$/.test(res);

    const hits = screenNames(this.corpus, {
      fullName: subject.fullName, romanizedName: subject.romanizedName,
      dob, nationality: nat, walletAddress: subject.walletAddress,
    }).map(h => ({ ...h, listVersion: this.versions[h.listId] ?? 0 }));

    // Decision
    const blocking = hits.filter(h => h.matchType === 'wallet' ||
      (h.corroborated && h.score >= 0.88 && h.identityComparison?.dob === 'match'));
    const blockingSet = new Set(blocking);
    // An uncorroborated romanised hit does not move the decision.
    // Expansion is our inference, not something the list says. Holding people on it catches
    // ordinary Korean names in bulk, as the evaluation showed. The hit still lands in evidence.
    const drivesDecision = (h: ScreeningHit) =>
      h.matchType !== 'romanized' || (h.directNameScore ?? 0) >= 0.82 || h.corroborated || !!h.corroboration?.length;
    const suspicious = hits.filter(h => !blockingSet.has(h) && h.score >= 0.82 && drivesDecision(h));
    const suspiciousSet = new Set(suspicious);
    const jr = [jurisdictionRisk(nat), jurisdictionRisk(res)].sort((a, b) => b.level - a.level)[0];

    let decision: Decision = 'ALLOW';
    let reviewReason: ReviewReason | undefined;
    let band: 1 | 2 | 3 | 4 | 5 = 1;

    if (blocking.length) {
      decision = 'BLOCK'; band = 5;
    } else if (suspicious.length) {
      decision = 'REVIEW'; reviewReason = suspicious.some(h => h.identityComparison && identityConflicts(h.identityComparison))
        ? 'IDENTITY_CONFLICT' : 'NAME_SIMILARITY'; band = 4;
    } else if (!nameAvailable) {
      decision = 'REVIEW'; reviewReason = 'SCREENING_UNAVAILABLE'; band = 4;
    } else if (!nameApplied || !jurisdictionApplied) {
      decision = 'REVIEW'; reviewReason = 'SCREENING_INPUT_INVALID'; band = 4;
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
    const methodsApplied = (nameApplied ? M.SANCTIONS_SCREENED : 0) | (jurisdictionApplied ? M.JURISDICTION_CHECK : 0);
    // Exact listed-wallet lookup is not transaction-graph/exposure screening. Keep bit 20
    // unset rather than silently changing the meaning expected by existing policies.

    const norm = normalizeName(subject.fullName);
    const toks = contentTokens(tokenize(norm));
    const variants = [...new Set([
      ...(hasHangul(subject.fullName) ? romanizeVariants(subject.fullName) : []),
      ...(subject.romanizedName ? [normalizeName(subject.romanizedName)] : []),
    ])].sort();
    const hmac = (v: string) => '0x' + createHmac('sha256', this.opts.evidenceKey).update(v.normalize('NFC')).digest('hex').slice(0, 32);
    const keyId = this.opts.keyId ?? 'default';

    const evidence: ScreeningEvidence = {
      ...(this.opts.provenance ? { sourceSnapshot: structuredClone(this.opts.provenance) } : {}),
      engineVersion: ENGINE_VERSION,
      listVersions: { ...this.versions },
      keyId,
      nameDigest: hmac(norm),
      tokenDigests: toks.map(hmac),
      variantDigests: variants.map(hmac),
      checks: [
        { id: 'sanctions.name', applied: nameApplied, passed: nameApplied && !blocking.some(h => h.matchType !== 'wallet') && suspicious.length === 0,
          status: !nameAvailable ? 'unavailable' : nameApplied ? 'completed' : 'skipped', provider: 'proofmark:local-lists', version: ENGINE_VERSION,
          note: `${hits.filter(h => h.matchType !== 'wallet').length} name candidate hit(s); ${suspicious.length} require review; list editions are recorded separately` },
        { id: 'sanctions.wallet', applied: walletApplied, passed: walletApplied && !hits.some(h => h.matchType === 'wallet'),
          status: walletApplied ? 'completed' : this.corpus.byWallet.size ? 'skipped' : 'unavailable', provider: 'proofmark:local-lists', version: ENGINE_VERSION,
          note: 'exact listed EVM address lookup only; no transaction graph/exposure analysis and no bit 20' },
        { id: 'jurisdiction.fatf', applied: jurisdictionApplied, passed: jurisdictionApplied && jr.level === 0,
          status: jurisdictionApplied ? 'completed' : 'skipped', provider: 'fatf-gafi.org', version: FATF.snapshotId,
          note: `self-declared nationality/residence, not identity verification; statement ${FATF.asOf}; ${jr.reason}`.trim() },
        { id: 'identity.dob',       applied: true,  passed: !!dob },
        { id: 'pep', applied: false, passed: false, status: 'unavailable', note: 'screening not implemented, bit left unset' },
        { id: 'adverseMedia', applied: false, passed: false, status: 'unavailable', note: 'screening not implemented, bit left unset' },
        { id: 'onchain.exposure', applied: false, passed: false, status: 'unavailable', note: 'graph/exposure screening not implemented, bit left unset' },
      ],
      hitDigests: hits.map(h => `${h.listId}:${h.entryId}:${h.matchType}:${h.score.toFixed(3)}:${h.corroborated ? 'c' : 'u'}:dob=${h.identityComparison?.dob ?? 'na'}:nationality=${h.identityComparison?.nationality ?? 'na'}:direct=${h.directNameScore?.toFixed(3) ?? 'na'}:inferred=${h.inferredNameScore?.toFixed(3) ?? 'na'}`).sort(),
    };

    // A presentation cap (the public API displays eight) must show decision-driving hits first.
    const priority = (h: ScreeningHit) => blockingSet.has(h) ? 2 : suspiciousSet.has(h) ? 1 : 0;
    const orderedHits = [...hits].sort((a, b) => priority(b) - priority(a) || b.score - a.score);
    return {
      decision, reviewReason, riskBand: band, hits: orderedHits, methodsApplied,
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
