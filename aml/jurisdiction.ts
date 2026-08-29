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
  source: 'https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions.html',
  asOf: '2026-08-30',
  verified: false,   // not yet checked against the source. Shows as unverified on screen and in evidence.
  callForAction: ['KP', 'IR', 'MM'],
  increasedMonitoring: [
    'BF','CM','HR','CD','HT','ML','MZ','MC','NA','NP','NG','PH','SN','ZA','SS','SY','TZ','TR','VU','VE','VN','YE',
  ],
};

export function jurisdictionRisk(iso2: string): { level: 0 | 1 | 2; reason: string } {
  const c = (iso2 ?? '').toUpperCase();
  if (FATF.callForAction.includes(c))       return { level: 2, reason: 'FATF call-for-action jurisdiction' };
  if (FATF.increasedMonitoring.includes(c)) return { level: 1, reason: 'FATF increased-monitoring jurisdiction' };
  return { level: 0, reason: '' };
}
