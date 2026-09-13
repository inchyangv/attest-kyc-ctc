import { createHash } from 'node:crypto';
import { ListBackedAmlEngine } from '../aml/engine.js';
import type { SanctionEntry } from '../aml/ingest/parse.js';
import type { ScreeningSubject } from '../aml/types.js';
import { canonicalJson } from './canonical.js';
import { isTrainingScenario, TRAINING_SCENARIOS, type SanctionsTrainingResult } from './sanctions-training-model.js';

// The engine's internal ListId union has official-format namespaces only. This fixture uses
// one schema slot, NOT actual OFAC data. Never export the raw ScreeningResult or method bits.
const entry: SanctionEntry = { listId: 'OFAC_SDN', entryId: 'FICTIONAL-TRAINING-ONLY-1',
  primaryName: 'Zorvax Quenlith', names: ['Zorvax Quenlith'], dobs: ['2000-01-01'], countries: ['KR'],
  programs: [], cryptoAddresses: [], type: 'individual' };
const inputs: Record<typeof TRAINING_SCENARIOS[number], ScreeningSubject> = {
  'full-match': { fullName: entry.primaryName, dateOfBirth: '2000-01-01', nationality: 'KR', residence: 'KR', walletAddress: '' },
  'name-only': { fullName: entry.primaryName, dateOfBirth: '', nationality: '', residence: '', walletAddress: '' },
  'dob-conflict': { fullName: entry.primaryName, dateOfBirth: '2001-02-03', nationality: 'KR', residence: 'KR', walletAddress: '' },
  'no-match': { fullName: 'Belmoric Xanthuvo', dateOfBirth: '2000-01-01', nationality: 'KR', residence: 'KR', walletAddress: '' },
};
const datasetHash = createHash('sha256').update(canonicalJson({ entry, inputs })).digest('hex');

/** Fixed fictional inputs only; no file-backed list loader, vendor, wallet, journal or signer.
 * The result cannot implement AmlEngine and is not accepted as an issuance proof. */
export async function runSanctionsTraining(scenario: unknown): Promise<SanctionsTrainingResult> {
  if (!isTrainingScenario(scenario)) throw new Error('unknown training scenario');
  const subject = structuredClone(inputs[scenario]);
  const engine = new ListBackedAmlEngine({ entries: [structuredClone(entry)], listVersions: { OFAC_SDN: 1 },
    // Public fixture-only value, not an operational privacy key. No input comes from a person.
    evidenceKey: 'PUBLIC-FICTIONAL-TRAINING-ONLY-NOT-A-PRODUCTION-KEY', keyId: 'synthetic-training-only' });
  const r = await engine.screen(subject);
  const explanation = r.decision === 'BLOCK'
    ? 'The fictional record has a strong name match and matching full date of birth without an identity conflict. The current engine blocks this training case.'
    : r.decision === 'REVIEW'
      ? r.reviewReason === 'IDENTITY_CONFLICT'
        ? 'The name matches but the supplied date of birth conflicts. The current engine requires review, not an automatic block or clearance.'
        : 'The name matches but there is not enough supporting identity information. The current engine requires review.'
      : 'No matching record was found in this one-record fictional corpus. This is not clearance against official lists or an identity verification.';
  return { schema: 'proofmark-synthetic-screening/v1', scope: 'synthetic-training-only', scenario,
    dataset: { label: 'Fictional training corpus — not an official sanctions list', sha256: datasetHash, entries: 1 },
    subject: { name: subject.fullName, dateOfBirth: subject.dateOfBirth, nationality: subject.nationality },
    fixture: { name: entry.primaryName, datesOfBirth: [...entry.dobs], nationalities: [...entry.countries] },
    trainingDecision: r.decision, explanation,
    comparisons: r.hits.map(hit => ({ score: hit.score, dateOfBirth: hit.identityComparison?.dob ?? 'missing',
      nationality: hit.identityComparison?.nationality ?? 'missing' })),
    engineVersion: r.engineVersion, executedAt: r.screenedAt,
    officialListsChecked: false, eligibleForIssuance: false, credentialCreated: false };
}
