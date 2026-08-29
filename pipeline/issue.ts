import { ethers } from 'ethers';

import { EvidenceChain } from './evidence.js';
import { claimsRoot, newSalt, type Claim } from './claims.js';
import { reconcile, type ReconcileInput } from './reconcile.js';
import { packAttrs } from './attrs.js';
import { EXPIRY_DAYS_BY_BAND, type AmlEngine, type ScreeningSubject } from './aml.js';
import { KrAdapter } from './adapters/kr.js';
import { describeMethods } from './methods.js';

export interface IssueRequest {
  wallet: string;
  declared: { fullName: string; dateOfBirth: string; nationality: string; residence: string };
  idImage: Uint8Array | null;
  bank?: { bankCode: string; accountNumber: string };
  /** Result of verifying the EIP-4361 wallet ownership signature */
  walletControlProven: boolean;
  jurisdiction: number;   // ISO-3166 numeric (KR = 410)
  kind?: number;          // 1 INDIVIDUAL
  assurance: number;   // issuer's own grade, 1..5
}

export type IssueOutcome =
  | { status: 'ISSUED'; attrs: string; claimsRoot: string; evidenceHash: string;
      methods: number; methodNames: string[]; expiry: number; regime: number;
      claims: Claim[]; evidence: unknown }
  | { status: 'DENIED'; reason: string; evidenceHash: string; evidence: unknown }
  | { status: 'REVIEW'; reason: string; evidenceHash: string; evidence: unknown }
  | { status: 'REJECTED'; reason: string; evidenceHash: string; evidence: unknown };

/**
 * Issuance orchestration.
 *
 * 0 wallet control, 1 ID document, 2 bank account, 3 reconciliation, 4 AML,
 *
 * Every step appends to the evidence chain. Cleartext PII stays out of the evidence too:
 */
export async function runIssuance(
  req: IssueRequest,
  adapter: KrAdapter,
  aml: AmlEngine,
  now: number = Date.now(),
): Promise<IssueOutcome> {
  const chain = new EvidenceChain();
  const at = now;

  chain.append({
    step: 'wallet_control',
    at,
    payload: { wallet: req.wallet.toLowerCase(), proven: req.walletControlProven },
  });
  if (!req.walletControlProven) {
    return { status: 'REJECTED', reason: 'wallet control not proven', evidenceHash: chain.hash, evidence: chain.export() };
  }

  // 1 and 2. jurisdiction adapter: ID document and bank account
  const adapterResult = await adapter.run({
    idImage: req.idImage,
    bank: req.bank,
    walletControlProven: req.walletControlProven,
  });
  chain.append({ step: 'jurisdiction_adapter', at, payload: adapterResult.evidence });

  // 3. reconciliation: all three axes must agree
  const recInput: ReconcileInput = {
    declared: { fullName: req.declared.fullName, dateOfBirth: req.declared.dateOfBirth },
    idDocument: adapterResult.idDocument,
    bankAccount: adapterResult.bankAccount,
  };
  const rec = reconcile(recInput);
  chain.append({ step: 'reconcile', at, payload: { axes: rec.axes, digests: rec.digests, passed: rec.passed } });
  if (!rec.passed) {
    return { status: 'REJECTED', reason: `reconciliation failed: ${JSON.stringify(rec.axes)}`,
             evidenceHash: chain.hash, evidence: chain.export() };
  }

  // 4. AML screening
  const subject: ScreeningSubject = {
    fullName: req.declared.fullName,
    dateOfBirth: req.declared.dateOfBirth,
    nationality: req.declared.nationality,
    residence: req.declared.residence,
    walletAddress: req.wallet,
  };
  const screening = await aml.screen(subject);
  chain.append({
    step: 'aml',
    at,
    payload: {
      decision: screening.decision, riskBand: screening.riskBand,
      hitCount: screening.hits.length, listVersions: screening.listVersions,
      engineVersion: screening.engineVersion, reviewReason: screening.reviewReason,
      methodsApplied: screening.methodsApplied, evidence: screening.evidence,
    },
  });

  if (screening.decision === 'BLOCK') {
    return { status: 'DENIED', reason: `sanctions or high-risk decision (band ${screening.riskBand})`,
             evidenceHash: chain.hash, evidence: chain.export() };
  }
  if (screening.decision === 'REVIEW') {
    return { status: 'REVIEW', reason: screening.reviewReason ?? 'MANUAL_FLAG',
             evidenceHash: chain.hash, evidence: chain.export() };
  }

  // 5. claim commitment. The salts stay in the user's browser.
  const claims: Claim[] = [
    { key: 'fullName',    value: req.declared.fullName,    salt: newSalt() },
    { key: 'dateOfBirth', value: req.declared.dateOfBirth, salt: newSalt() },
    { key: 'nationality', value: req.declared.nationality, salt: newSalt() },
    { key: 'residence',   value: req.declared.residence,   salt: newSalt() },
  ];
  if (adapterResult.idDocument) {
    claims.push({ key: 'idDocHash', value: adapterResult.idDocument.docHash, salt: newSalt() });
  }
  if (adapterResult.bankAccount) {
    claims.push({ key: 'accountHolder', value: adapterResult.bankAccount.holderName, salt: newSalt() });
  }
  const root = claimsRoot(claims);
  chain.append({ step: 'commitment', at, payload: { claimsRoot: root, claimCount: claims.length } });

  // 6. pack attrs: identity checks plus screening checks
  const methods = adapterResult.methods | screening.methodsApplied;
  const issuedAt = Math.floor(at / 1000);
  const expiry = issuedAt + EXPIRY_DAYS_BY_BAND[screening.riskBand] * 86_400;

  const attrs = packAttrs({
    kind: req.kind ?? 1,
    assurance: req.assurance,
    regime: adapterResult.regime,
    jurisdiction: req.jurisdiction,
    methods,
    issuedAt,
    expiry,
    epoch: 0,   // Mode A, individual proof, no epoch
  });

  const evidenceHash = chain.append({ step: 'issue', at, payload: { attrs, claimsRoot: root } });

  return {
    status: 'ISSUED',
    attrs, claimsRoot: root, evidenceHash,
    methods, methodNames: describeMethods(methods),
    expiry, regime: adapterResult.regime,
    claims, evidence: chain.export(),
  };
}

/** Turns an issuance result into arguments for Sepolia `ComplianceSource.issue()`. */
export function toIssueCall(wallet: string, out: Extract<IssueOutcome, { status: 'ISSUED' }>) {
  return {
    subject: ethers.getAddress(wallet),
    attrs: out.attrs,
    claimsRoot: out.claimsRoot,
    evidenceHash: out.evidenceHash,
  };
}
