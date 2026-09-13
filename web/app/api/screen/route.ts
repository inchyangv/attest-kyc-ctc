import { privateJson } from '@/lib/private-response';
import { getEngine } from '@/lib/aml-server';
import { evidenceDigest } from '@aml/engine.js';
import { Methods } from '@pipeline/methods.js';
import { ENGINE_VERSION } from '@aml/normalize.js';
import { guardError, guardRequest } from '@/lib/request-guard';
import { BODY_LIMITS, readJsonObject } from '@/lib/request-body';

export const runtime = 'nodejs';

const fail = (e: unknown) => {
  const guarded = guardError(e); if (guarded) return guarded;
  return privateJson({ error: 'Screening is unavailable. No current screening result was produced.', code: 'SCREENING_UNAVAILABLE' }, { status: 503 });
};

/**
 * This endpoint runs AML screening only. Identity bits belong to the issuance pipeline, so
 * lumping them all under "not integrated" here would overstate the gap. Group by who owns each check.
 */
const GROUPS: { group: string; note: string; items: [keyof typeof Methods, string][] }[] = [
  {
    group: 'Run by this screening',
    note: 'Applied when the required local data and input are available; nationality/residence are self-declared.',
    items: [
      ['SANCTIONS_SCREENED', 'Sanctions lists'],
      ['JURISDICTION_CHECK', 'Jurisdiction (FATF)'],
    ],
  },
  {
    group: 'Not implemented here',
    note: 'These bits stay unset. Exact listed-wallet lookup is separate from transaction-graph exposure analysis.',
    items: [
      ['PEP_SCREENED', 'Politically exposed persons'],
      ['ADVERSE_MEDIA', 'Adverse media'],
      ['ONCHAIN_EXPOSURE', 'Transaction-graph exposure analysis'],
    ],
  },
  {
    group: 'Identity checks',
    note: 'Set by the issuance flow at /verify, not by screening.',
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
export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'screen-status', limit: 60, windowMs: 60_000 });
    const { meta } = getEngine();
    return privateJson({
      engineVersion: ENGINE_VERSION,
      listVersions: meta.listVersions,
      listCounts: meta.counts,
      builtAt: meta.builtAt,
      sourceUpdatedAt: meta.sourceUpdatedAt,
      sourceSnapshot: meta.provenance,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return fail(e); }
}

export async function POST(req: Request) {
  try {
    guardRequest(req, { bucket: 'screen', limit: 30, windowMs: 60_000, maxBodyBytes: BODY_LIMITS.screen, sameOrigin: true });
    const body = await readJsonObject(req, BODY_LIMITS.screen);
    const { fullName, dateOfBirth, nationality, residence, walletAddress } = body ?? {};
    if (!fullName || typeof fullName !== 'string') {
      return privateJson({ error: 'Full name is required' }, { status: 400 });
    }
    if ([dateOfBirth, nationality, residence, walletAddress].some(v => v !== undefined && typeof v !== 'string')) {
      return privateJson({ error: 'screening fields must be strings' }, { status: 400 });
    }

    const { engine, meta } = getEngine();
    const t0 = Date.now();
    const r = await engine.screen({
      fullName: fullName.slice(0, 200),
      dateOfBirth: String(dateOfBirth ?? '').slice(0, 10),
      nationality: String(nationality ?? '').slice(0, 2),
      residence: String(residence ?? nationality ?? '').slice(0, 2),
      walletAddress: String(walletAddress ?? '').slice(0, 42),
    });

    const M = Methods as Record<string, number>;
    const methodGroups = GROUPS.map(g => ({
      group: g.group,
      note: g.note,
      items: g.items.map(([k, label]) => ({ key: k, label, set: (r.methodsApplied & M[k]) !== 0 })),
    }));

    return privateJson({
      decision: r.decision,
      reviewReason: r.reviewReason ?? null,
      riskBand: r.riskBand,
      hits: r.hits.slice(0, 8),
      methodsApplied: r.methodsApplied,
      methodsHex: '0x' + r.methodsApplied.toString(16),
      methodGroups,
      checks: r.evidence.checks,
      engineVersion: r.engineVersion,
      listVersions: r.listVersions,
      listCounts: meta.counts,
      builtAt: meta.builtAt,
      sourceUpdatedAt: meta.sourceUpdatedAt,
      sourceSnapshot: meta.provenance,
      evidenceDigest: evidenceDigest(r.evidence),
      elapsedMs: Date.now() - t0,
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return fail(e); }
}
