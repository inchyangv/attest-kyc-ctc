/**
 * FATF jurisdiction risk. The plenary changes it, so we carry the verification state alongside.
 * With verified=false the evidence records the table as unverified rather than implying certainty.
 */
export interface JurisdictionTable {
  source: string;
  asOf: string;
  verified: boolean;   // checked by eye against the latest fatf-gafi.org plenary outcome
  callForAction: string[];   // call for action, formerly the blacklist
  increasedMonitoring: string[];   // increased monitoring, formerly the greylist
}

export const FATF: JurisdictionTable = {
  source: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/increased-monitoring-june-2026.html',
  asOf: '2026-06-19',
  verified: true,
  callForAction: ['KP', 'IR', 'MM'],
  increasedMonitoring: [
    'AO','BO','BA','BG','CM','CI','CD','HT','IQ','KE','KW','LA','LB','MC','NP','PG','SS','SY','VE','VN','VG','YE',
  ],
};

export function jurisdictionRisk(iso2: string): { level: 0 | 1 | 2; reason: string } {
  const c = (iso2 ?? '').toUpperCase();
  if (FATF.callForAction.includes(c))       return { level: 2, reason: 'FATF call-for-action jurisdiction' };
  if (FATF.increasedMonitoring.includes(c)) return { level: 1, reason: 'FATF increased-monitoring jurisdiction' };
  return { level: 0, reason: '' };
}
