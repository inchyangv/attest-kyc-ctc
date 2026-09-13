/** Shared display contract only. It is deliberately not a ScreeningResult or sealed proof. */
export const TRAINING_SCENARIOS = ['full-match', 'name-only', 'dob-conflict', 'no-match'] as const;
export type TrainingScenario = typeof TRAINING_SCENARIOS[number];
export function isTrainingScenario(value: unknown): value is TrainingScenario {
  return typeof value === 'string' && (TRAINING_SCENARIOS as readonly string[]).includes(value);
}
export interface SanctionsTrainingResult {
  schema: 'proofmark-synthetic-screening/v1';
  scope: 'synthetic-training-only'; scenario: TrainingScenario;
  dataset: { label: 'Fictional training corpus — not an official sanctions list'; sha256: string; entries: number };
  subject: { name: string; dateOfBirth: string; nationality: string };
  fixture: { name: string; datesOfBirth: string[]; nationalities: string[] };
  trainingDecision: 'ALLOW' | 'REVIEW' | 'BLOCK'; explanation: string;
  comparisons: { score: number; dateOfBirth: string; nationality: string }[];
  engineVersion: string; executedAt: number;
  officialListsChecked: false; eligibleForIssuance: false; credentialCreated: false;
}

/** Prevent a live result, stale scenario response or arbitrary payload being painted as training. */
export function isTrainingResult(value: unknown, scenario: TrainingScenario): value is SanctionsTrainingResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as SanctionsTrainingResult;
  return v.schema === 'proofmark-synthetic-screening/v1' && v.scope === 'synthetic-training-only' && v.scenario === scenario
    && v.officialListsChecked === false && v.eligibleForIssuance === false && v.credentialCreated === false
    && ['ALLOW', 'REVIEW', 'BLOCK'].includes(v.trainingDecision) && typeof v.explanation === 'string'
    && v.dataset?.label === 'Fictional training corpus — not an official sanctions list' && /^[0-9a-f]{64}$/.test(v.dataset.sha256)
    && v.dataset.entries === 1 && typeof v.subject?.name === 'string' && typeof v.subject.dateOfBirth === 'string'
    && typeof v.subject.nationality === 'string' && typeof v.fixture?.name === 'string'
    && Array.isArray(v.fixture.datesOfBirth) && v.fixture.datesOfBirth.every(d => typeof d === 'string')
    && Array.isArray(v.fixture.nationalities) && v.fixture.nationalities.every(c => typeof c === 'string')
    && Array.isArray(v.comparisons) && v.comparisons.length <= 1 && v.comparisons.every(c =>
      c && typeof c === 'object' && Number.isFinite(c.score) && c.score >= 0 && c.score <= 1 && ['match', 'year-match', 'conflict', 'missing', 'invalid'].includes(c.dateOfBirth)
      && ['match', 'conflict', 'missing', 'invalid'].includes(c.nationality))
    && typeof v.engineVersion === 'string' && Number.isSafeInteger(v.executedAt) && v.executedAt > 0;
}
