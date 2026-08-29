/**
 * AML contract. `aml/types.ts` owns these types.
 *
 * Same rule as `Methods`: define a type twice and the two copies drift.
 * They already had. The pipeline's `MatchType` was missing `'wallet'`, so wallet-address
 * matching had no way to be expressed. The typechecker caught it.
 * The screening engine owns the contract, so this file only re-exports.
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
 * riskBand to mark lifetime in days. Higher risk means shorter, so it is re-checked sooner.
 * This is issuance policy, so the pipeline decides it, not the screening engine.
 */
export const EXPIRY_DAYS_BY_BAND: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 365, 2: 180, 3: 90, 4: 60, 5: 30,
};

/**
 * Mock AML engine, for running the pipeline where the source lists in `data/raw/` are absent.
 *
 * It reads no real sanctions list, so it does not set `SANCTIONS_SCREENED`.
 * Setting it would be a lie. With the bit at zero a consumer policy filters the mark out,
 * so a mark issued through the mock cannot open a gate that requires sanctions screening.
 * That is the intended behaviour. The real engine is `ListBackedAmlEngine` in `aml/engine.ts`.
 */
export class MockAmlEngine implements AmlEngine {
  readonly engineVersion = 'mock-0.1.0';
  private readonly evidenceKey: string;
  private readonly keyId: string;

  /**
   * Evidence pseudonymisation key.
   * If only the mock used an unsalted hash, the evidence would look protected without being so.
   */
  constructor(opts: { evidenceKey: string; keyId?: string }) {
    if (!opts?.evidenceKey) throw new Error('MockAmlEngine: evidenceKey is required');
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
      // only the jurisdiction check actually ran, so only that bit is set
      methodsApplied: Methods.JURISDICTION_CHECK,
      listVersions: {},
      engineVersion: this.engineVersion,
      screenedAt,
      evidence: {
        engineVersion: this.engineVersion,
        listVersions: {},
        // A keyed HMAC goes in, never the cleartext name.
        // PII in the evidence puts the right to erasure against the audit trail: erase the
        // vault and evidenceHash can no longer be recomputed.
        // An unsalted hash is not enough either. Names carry too little entropy.
        // evidence-key.ts carries the full reasoning.
        keyId: this.keyId,
        nameDigest: hmacDigest(this.evidenceKey, subject.fullName),
        tokenDigests: [],
        variantDigests: [],
        checks: [
          { id: 'jurisdiction', applied: true, passed: !isHighRisk },
          { id: 'sanctions_list', applied: false, passed: false,
            note: 'mock engine, no list consulted, SANCTIONS_SCREENED left unset' },
          { id: 'onchain_exposure', applied: false, passed: false, note: 'mock engine, sanctioned wallet list not consulted' },
        ],
        hitDigests: [],
      },
    };
  }

  async listVersions(): Promise<Record<string, number>> {
    return {};
  }
}
