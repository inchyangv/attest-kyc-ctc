/** Public fictional fixtures, not reserved real-world identifiers or institutional test accounts. */
export const SYNTHETIC_SCENARIOS = ['success', 'document-rejected', 'holder-mismatch'] as const;
export type SyntheticScenario = typeof SYNTHETIC_SCENARIOS[number];
export function syntheticProfile(scenario: SyntheticScenario) {
  if (!(SYNTHETIC_SCENARIOS as readonly string[]).includes(scenario)) throw new Error('unknown synthetic scenario');
  return {
    scenario, docType: 'RRC' as const,
    doc: { fullName: scenario === 'document-rejected' ? 'FAKE PROOFMARK SAMPLE PERSON' : 'PROOFMARK SAMPLE PERSON',
      birthDate: '20000101', rrn: '0001010000001', issueDate: '20240101', licenseNumber: '', serialNo: '' },
    bank: { bankCode: '004', accountNumber: scenario === 'holder-mismatch' ? '000000001299' : '000000001234' },
    country: { nationality: 'KR', residence: 'KR' },
  };
}

export class SyntheticSampleError extends Error {
  readonly code = 'SYNTHETIC_SAMPLE_UNAVAILABLE';
  constructor() { super('Synthetic samples require both built-in demo vendors. No institution request was made.'); }
}
/** Rechecked on the server for every sample request; demo mode alone is insufficient.
 * This is a routing safeguard, not a PII classifier or proof a payload is fictional. */
export function requireSyntheticSampleMode(requested: unknown, demo: boolean,
  id: { name: string; live: boolean } | null, bank: { name: string; live: boolean } | null): void {
  if (requested === undefined || requested === null || requested === '') return;
  if ((requested !== true && requested !== '1') || !demo || !id || !bank
    || id.name !== 'demo:id' || bank.name !== 'demo:bank' || id.live || bank.live) throw new SyntheticSampleError();
}
