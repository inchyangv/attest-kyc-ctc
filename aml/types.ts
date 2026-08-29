/**
 * AML screening engine, the public contract.
 * The issuance pipeline calls through this interface and nothing else.
 */

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
  listVersion: number;   // first 8 bytes of the source file hash, identifying the edition
  entryId: string;
  matchedName: string;
  score: number;               // 0..1
  matchType: MatchType;
  /** Whether this hit justifies blocking on its own.
   *  Romanised expansion is our inference, so it is false without a date of birth or country. */
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
  engineVersion: string;
  listVersions: Record<string, number>;
  keyId: string;   // which evidence key produced this, for rotation
  nameDigest: string;   // HMAC(key, normalised name)
  tokenDigests: string[];   // per-token HMAC, keeping matching reproducible
  variantDigests: string[];   // per-expansion HMAC
  checks: { id: string; applied: boolean; passed: boolean; note?: string }[];
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
