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
  /** EIP-4361 지갑 소유권 서명 검증 결과 */
  walletControlProven: boolean;
  jurisdiction: number;   // ISO-3166 numeric (KR = 410)
  kind?: number;          // 1 INDIVIDUAL
  assurance: number;      // 발급사 자체 등급 1..5
}

export type IssueOutcome =
  | { status: 'ISSUED'; attrs: string; claimsRoot: string; evidenceHash: string;
      methods: number; methodNames: string[]; expiry: number; regime: number;
      claims: Claim[]; evidence: unknown }
  | { status: 'DENIED'; reason: string; evidenceHash: string; evidence: unknown }
  | { status: 'REVIEW'; reason: string; evidenceHash: string; evidence: unknown }
  | { status: 'REJECTED'; reason: string; evidenceHash: string; evidence: unknown };

/**
 * 발급 오케스트레이션.
 *
 * 0 지갑 소유권 → 1 신분증 → 2 계좌 → 3 맵핑 대사 → 4 AML → 5 커밋먼트 → 6 attrs
 *
 * 각 단계는 증적 체인에 append 된다. **PII 원문은 증적에도 넣지 않는다** — 해시와 판정만.
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
    return { status: 'REJECTED', reason: '지갑 소유권 미증명', evidenceHash: chain.hash, evidence: chain.export() };
  }

  // 1·2. 관할 어댑터 (신분증 · 계좌)
  const adapterResult = await adapter.run({
    idImage: req.idImage,
    bank: req.bank,
    walletControlProven: req.walletControlProven,
  });
  chain.append({ step: 'jurisdiction_adapter', at, payload: adapterResult.evidence });

  // 3. 맵핑 대사 — 세 축이 모두 일치해야 한다
  const recInput: ReconcileInput = {
    declared: { fullName: req.declared.fullName, dateOfBirth: req.declared.dateOfBirth },
    idDocument: adapterResult.idDocument,
    bankAccount: adapterResult.bankAccount,
  };
  const rec = reconcile(recInput);
  chain.append({ step: 'reconcile', at, payload: { axes: rec.axes, digests: rec.digests, passed: rec.passed } });
  if (!rec.passed) {
    return { status: 'REJECTED', reason: `맵핑 대사 실패: ${JSON.stringify(rec.axes)}`,
             evidenceHash: chain.hash, evidence: chain.export() };
  }

  // 4. AML 심사
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
    return { status: 'DENIED', reason: `제재/고위험 판정 (밴드 ${screening.riskBand})`,
             evidenceHash: chain.hash, evidence: chain.export() };
  }
  if (screening.decision === 'REVIEW') {
    return { status: 'REVIEW', reason: screening.reviewReason ?? 'MANUAL_FLAG',
             evidenceHash: chain.hash, evidence: chain.export() };
  }

  // 5. 클레임 커밋먼트 — salt 는 이용자 브라우저에만 남는다
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

  // 6. attrs 팩킹 — 확인 행위 ∪ 심사 행위
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
    epoch: 0,                       // Mode A(개별 증명) — 에폭 없음
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

/** 발급 결과를 Sepolia `ComplianceSource.issue()` 인자로 변환한다. */
export function toIssueCall(wallet: string, out: Extract<IssueOutcome, { status: 'ISSUED' }>) {
  return {
    subject: ethers.getAddress(wallet),
    attrs: out.attrs,
    claimsRoot: out.claimsRoot,
    evidenceHash: out.evidenceHash,
  };
}
