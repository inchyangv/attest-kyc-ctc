/**
 * AML screening engine, the public contract.
 * The issuance pipeline calls through this interface and nothing else.
 */

import type { IdentityComparison } from './identity.js';
import type { ListProvenance } from './provenance.js';

export interface ScreeningSubject {
  fullName: string;
  romanizedName?: string;   // the engine expands it when absent
  dateOfBirth: string;         // YYYY-MM-DD
  nationality: string;         // ISO-3166 alpha-2
  residence: string;           // ISO-3166 alpha-2
  walletAddress: string;
}

export type ListId = 'OFAC_SDN' | 'UN_CONSOLIDATED' | 'EU_FSF';
export type MatchType = 'exact' | 'fuzzy' | 'alias' | 'romanized' | 'wallet';

export interface ScreeningHit {
  listId: ListId;
  listVersion: number;   // first 32 bits of SHA-256; full hashes are in sourceSnapshot
  entryId: string;
  matchedName: string;
  score: number;               // 0..1
  matchType: MatchType;
  /** Positive supplied identity descriptors with no explicit conflict/invalid comparison.
   * Not a legal match determination or proof of identity; year/country support alone does not block. */
  corroborated: boolean;
  corroboration?: ('dob' | 'nationality' | 'wallet')[];
  /** Absent on legacy/provider fixtures; the built-in engine emits it for every name hit. */
  identityComparison?: IdentityComparison;
  /** Preserve both paths when an inferred expansion has a higher score than a supplied name. */
  directNameScore?: number;
  inferredNameScore?: number;
}

export type Decision = 'ALLOW' | 'BLOCK' | 'REVIEW';
export type ReviewReason =
  | 'NAME_SIMILARITY' | 'IDENTITY_CONFLICT' | 'DOB_MISSING' | 'HIGH_RISK_JURISDICTION'
  | 'SCREENING_UNAVAILABLE' | 'SCREENING_INPUT_INVALID'
  | 'ONCHAIN_EXPOSURE' | 'MANUAL_FLAG';

export interface ScreeningResult {
  decision: Decision;
  reviewReason?: ReviewReason;
  riskBand: 1 | 2 | 3 | 4 | 5;   // 1 is lowest, expiry 365 days; 5 is highest, 30 days
  hits: ScreeningHit[];
  methodsApplied: number;   // Set a bit only for screening that actually ran
  listVersions: Record<string, number>;
  engineVersion: string;   // normalisation and matching rule version, the other half of reproducibility
  screenedAt: number;
  evidence: ScreeningEvidence;
}

/**
 * Must be deterministic. An auditor recomputes evidenceHash from their copy and compares.
 *
 * No cleartext names. Evidence is kept permanently while the vault must be erasable on
 * request, and PII in the evidence puts those two in conflict: erase the vault and the audit
 *
 * This is pseudonymisation, not anonymisation. Names carry little entropy, so an unsalted
 * hash falls to a dictionary attack. We HMAC with a key the issuer holds. The key holder can
 * confirm a candidate, which is the point. Without the key the digest yields nothing.
 */
export interface ScreeningEvidence {
  sourceSnapshot?: ListProvenance; // Absent for historical/provider/synthetic fixtures; no freshness claim.
  engineVersion: string;
  listVersions: Record<string, number>;
  keyId: string;   // which evidence key produced this, for rotation
  nameDigest: string;   // HMAC(key, normalised name)
  tokenDigests: string[];   // per-token HMAC, keeping matching reproducible
  variantDigests: string[];   // per-expansion HMAC
  checks: { id: string; applied: boolean; passed: boolean; note?: string;
    status?: 'completed' | 'skipped' | 'unavailable'; provider?: string; version?: string }[];
  hitDigests: string[];   // listId:entryId:matchType:score to 3 places
}

export interface AmlEngine {
  screen(subject: ScreeningSubject): Promise<ScreeningResult>;
  listVersions(): Promise<Record<string, number>>;
}

/** Do not redefine the methods bits here. A second definition drifts eventually.
 *  `pipeline/methods.ts` owns them, and a test ties that file to `ProofmarkTypes.sol`. */
export { Methods as M } from '../pipeline/methods.js';

/** Risk band to attestation lifetime in days. See the plan, section 6.2. */
export const BAND_TO_DAYS: Record<number, number> = { 1: 365, 2: 180, 3: 90, 4: 60, 5: 30 };
