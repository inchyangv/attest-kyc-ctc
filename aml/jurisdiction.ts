import { createHash } from 'node:crypto';

/**
 * FATF jurisdiction risk. The plenary changes it, so we carry the verification state alongside.
 * This versioned observation is independent from the OFAC/UN/EU snapshot and expires on its own.
 */
export interface JurisdictionTable {
  v: 1;
  snapshotId: string;
  source: string;
  sources: { callForAction: string; increasedMonitoring: string };
  asOf: string;
  verifiedAt: string;
  verified: true;
  callForAction: string[];   // call for action, formerly the blacklist
  increasedMonitoring: string[];   // increased monitoring, formerly the greylist
}

const body: Omit<JurisdictionTable, 'snapshotId'> = {
  v: 1,
  source: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/increased-monitoring-june-2026.html',
  sources: {
    callForAction: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/call-for-action-june-2026.html',
    increasedMonitoring: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/increased-monitoring-june-2026.html',
  },
  asOf: '2026-06-19',
  verifiedAt: '2026-09-07T15:00:00.000Z',
  verified: true,
  callForAction: ['KP', 'IR', 'MM'],
  increasedMonitoring: [
    'AO','BO','BA','BG','CM','CI','CD','HT','IQ','KE','KW','LA','LB','MC','NP','PG','SS','SY','VE','VN','VG','YE',
  ],
};
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
export const jurisdictionTableId = (value: Omit<JurisdictionTable, 'snapshotId'>) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const FATF: JurisdictionTable = { ...body, snapshotId: jurisdictionTableId(body) };
export const MAX_FATF_AGE_DAYS = 180;
export function fatfFreshnessDays(value = process.env.FATF_MAX_AGE_DAYS ?? '120'): number {
  const days = Number(value);
  if (!value.trim() || !Number.isFinite(days) || days <= 0 || days > MAX_FATF_AGE_DAYS) throw new Error(`FATF_MAX_AGE_DAYS must be > 0 and <= ${MAX_FATF_AGE_DAYS}`);
  return days;
}
export function assertJurisdictionTable(value: JurisdictionTable, now = Date.now(), maxAgeDays = fatfFreshnessDays()): void {
  const { snapshotId, ...content } = value;
  const observed = Date.parse(value.verifiedAt);
  const iso = (codes: unknown): codes is string[] => Array.isArray(codes) && codes.length > 0
    && codes.every(code => typeof code === 'string' && /^[A-Z]{2}$/.test(code));
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > MAX_FATF_AGE_DAYS
    || value.v !== 1 || value.verified !== true || snapshotId !== jurisdictionTableId(content)
    || value.asOf !== '2026-06-19' || !Number.isFinite(observed) || new Date(observed).toISOString() !== value.verifiedAt
    || observed > now || now - observed > maxAgeDays * 86_400_000
    || value.sources.callForAction !== body.sources.callForAction || value.sources.increasedMonitoring !== body.sources.increasedMonitoring
    || value.source !== value.sources.increasedMonitoring || !iso(value.callForAction) || !iso(value.increasedMonitoring)
    || new Set(value.callForAction).size !== value.callForAction.length || new Set(value.increasedMonitoring).size !== value.increasedMonitoring.length
    || value.callForAction.some(code => value.increasedMonitoring.includes(code))) throw new Error('FATF_JURISDICTION_TABLE_INVALID_OR_STALE');
}

export function jurisdictionRisk(iso2: string): { level: 0 | 1 | 2; reason: string } {
  assertJurisdictionTable(FATF);
  const c = (iso2 ?? '').toUpperCase();
  if (FATF.callForAction.includes(c))       return { level: 2, reason: 'FATF call-for-action jurisdiction' };
  if (FATF.increasedMonitoring.includes(c)) return { level: 1, reason: 'FATF increased-monitoring jurisdiction' };
  return { level: 0, reason: '' };
}
