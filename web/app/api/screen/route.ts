import { NextResponse } from 'next/server';
import { getEngine } from '@/lib/aml-server';
import { evidenceDigest } from '@aml/engine.js';
import { Methods } from '@pipeline/methods.js';
import { ENGINE_VERSION } from '@aml/normalize.js';

export const runtime = 'nodejs';

/**
 * This endpoint runs AML screening only. Identity bits belong to the issuance pipeline, so
 * lumping them all under "not integrated" here would overstate the gap. Group by who owns each check.
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

/** What is loaded right now — shown on the page before the first screening runs. */
export async function GET() {
  const { meta } = getEngine();
  return NextResponse.json({ engineVersion: ENGINE_VERSION, listVersions: meta.listVersions, listCounts: meta.counts });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { fullName, dateOfBirth, nationality, residence, walletAddress } = body ?? {};
  if (!fullName || typeof fullName !== 'string') {
    return NextResponse.json({ error: 'Full name is required' }, { status: 400 });
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
