import { NextResponse } from 'next/server';
import { getEngine } from '@/lib/aml-server';
import { evidenceDigest } from '@aml/engine.js';
import { Methods } from '@pipeline/methods.js';

export const runtime = 'nodejs';

/**
 * 이 API 는 AML 심사만 한다. 신원확인 비트는 발급 파이프라인 소관이므로
 * 여기서 전부 "미연동"으로 뭉뚱그리면 격차를 과장하게 된다. 책임 주체별로 나눈다.
 */
const GROUPS: { group: string; note: string; items: [keyof typeof Methods, string][] }[] = [
  {
    group: 'Run by this screening',
    note: 'Performed here, against source lists, on every request.',
    items: [
      ['SANCTIONS_SCREENED', 'Sanctions lists'],
      ['JURISDICTION_CHECK', 'Jurisdiction (FATF)'],
      ['ONCHAIN_EXPOSURE', 'On-chain exposure'],
    ],
  },
  {
    group: 'Screening we cannot run yet',
    note: 'Commercial datasets we have not licensed. The bit stays unset — silence, not a guess.',
    items: [
      ['PEP_SCREENED', 'Politically exposed persons'],
      ['ADVERSE_MEDIA', 'Adverse media'],
    ],
  },
  {
    group: 'Identity checks — issuance pipeline',
    note: 'Set by the issuance flow, not by screening. This endpoint does not perform them.',
    items: [
      ['WALLET_CONTROL', 'Wallet control'],
      ['ID_DOC_IMAGE', 'ID document image'],
      ['ID_DOC_AUTHENTICITY', 'Document authenticity'],
      ['FACE_MATCH', 'Face match'],
      ['LIVENESS', 'Liveness'],
      ['BANK_ACCOUNT', 'Bank account (1-KRW)'],
      ['MOBILE_CARRIER', 'Mobile carrier'],
      ['EPASSPORT_NFC', 'ePassport NFC'],
      ['GOV_EID', 'Government eID'],
    ],
  },
];

export async function POST(req: Request) {
  const body = await req.json();
  const { fullName, dateOfBirth, nationality, residence, walletAddress } = body ?? {};
  if (!fullName || typeof fullName !== 'string') {
    return NextResponse.json({ error: '이름이 필요합니다' }, { status: 400 });
  }

  const { engine, meta } = getEngine();
  const t0 = Date.now();
  const r = await engine.screen({
    fullName: fullName.slice(0, 200),
    dateOfBirth: (dateOfBirth ?? '').slice(0, 10),
    nationality: (nationality ?? '').slice(0, 2),
    residence: (residence ?? nationality ?? '').slice(0, 2),
    walletAddress: (walletAddress ?? '').slice(0, 42),
  });

  const M = Methods as Record<string, number>;
  const methodGroups = GROUPS.map(g => ({
    group: g.group,
    note: g.note,
    items: g.items.map(([k, label]) => ({ key: k, label, set: (r.methodsApplied & M[k]) !== 0 })),
  }));

  return NextResponse.json({
    decision: r.decision,
    reviewReason: r.reviewReason ?? null,
    riskBand: r.riskBand,
    hits: r.hits.slice(0, 8),
    methodsApplied: r.methodsApplied,
    methodsHex: '0x' + r.methodsApplied.toString(16),
    methodGroups,
    engineVersion: r.engineVersion,
    listVersions: r.listVersions,
    listCounts: meta.counts,
    evidenceDigest: evidenceDigest(r.evidence),
    elapsedMs: Date.now() - t0,
  });
}
