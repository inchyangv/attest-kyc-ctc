import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListBackedAmlEngine, type EngineOptions } from './engine.js';
import { M } from './types.js';
import type { SanctionEntry } from './ingest/parse.js';

const listedWallet = '0x' + '12'.repeat(20);
const entry: SanctionEntry = { listId: 'OFAC_SDN', entryId: 'synthetic-capability', primaryName: 'Listed Synthetic Person',
  names: ['Listed Synthetic Person'], dobs: ['1970-01-01'], countries: ['US'], programs: [], cryptoAddresses: [listedWallet], type: 'individual' };
const options = (): EngineOptions => ({ entries: [entry], listVersions: { OFAC_SDN: 123 }, evidenceKey: 'synthetic-capability-key' });
const input = { fullName: 'Other Test Person', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '34'.repeat(20) };

test('PM-T28-01 data flags cannot activate unsupported PEP/adverse-media checks', () => {
  assert.throws(() => new ListBackedAmlEngine({ ...options(), hasPepData: true }), /not implemented/);
  assert.throws(() => new ListBackedAmlEngine({ ...options(), hasAdverseMedia: true }), /not implemented/);
});

test('configuration mutation cannot activate a check or change the recorded list edition', async () => {
  const config = options(); const engine = new ListBackedAmlEngine(config);
  config.hasPepData = true; config.hasAdverseMedia = true; config.listVersions.OFAC_SDN = 999;
  const result = await engine.screen(input);
  assert.equal(result.methodsApplied & (M.PEP_SCREENED | M.ADVERSE_MEDIA | M.ONCHAIN_EXPOSURE), 0);
  assert.equal(result.listVersions.OFAC_SDN, 123);
  for (const id of ['pep', 'adverseMedia', 'onchain.exposure']) {
    const check = result.evidence.checks.find(c => c.id === id)!;
    assert.equal(check.applied, false); assert.equal(check.passed, false); assert.equal(check.status, 'unavailable');
  }
});

test('listed-wallet lookup still blocks but cannot earn graph/exposure capability', async () => {
  const result = await new ListBackedAmlEngine(options()).screen({ ...input, walletAddress: listedWallet });
  assert.equal(result.decision, 'BLOCK'); assert.equal(result.methodsApplied & M.ONCHAIN_EXPOSURE, 0);
  const check = result.evidence.checks.find(c => c.id === 'sanctions.wallet')!;
  assert.equal(check.applied, true); assert.equal(check.passed, false); assert.equal(check.status, 'completed');
  assert.equal(check.provider, 'proofmark:local-lists'); assert.equal(check.version, result.engineVersion);
  assert.equal(result.evidence.checks.find(c => c.id === 'sanctions.name')?.passed, true, 'an unrelated name is not itself a failed name check');
  const both = await new ListBackedAmlEngine(options()).screen({ ...input, fullName: entry.primaryName, dateOfBirth: entry.dobs[0], nationality: 'US', walletAddress: listedWallet });
  assert.equal(both.evidence.checks.find(c => c.id === 'sanctions.name')?.passed, false, 'wallet deduplication cannot erase a real name failure');
  assert.equal(both.evidence.checks.find(c => c.id === 'sanctions.wallet')?.passed, false);
});

test('no data, no wallet input and invalid name are not successful completed checks', async () => {
  const empty = await new ListBackedAmlEngine({ ...options(), entries: [], listVersions: {} }).screen(input);
  assert.equal(empty.decision, 'REVIEW'); assert.equal(empty.reviewReason, 'SCREENING_UNAVAILABLE');
  assert.equal(empty.methodsApplied & M.SANCTIONS_SCREENED, 0);
  assert.equal(empty.evidence.checks.find(c => c.id === 'sanctions.name')?.status, 'unavailable');
  const skipped = await new ListBackedAmlEngine(options()).screen({ ...input, walletAddress: '' });
  assert.equal(skipped.evidence.checks.find(c => c.id === 'sanctions.wallet')?.status, 'skipped');
  assert.equal(skipped.evidence.checks.find(c => c.id === 'sanctions.wallet')?.passed, false);
  const invalid = await new ListBackedAmlEngine(options()).screen({ ...input, fullName: '!!!', nationality: '', residence: '' });
  assert.equal(invalid.decision, 'REVIEW'); assert.equal(invalid.reviewReason, 'SCREENING_INPUT_INVALID'); assert.equal(invalid.methodsApplied, 0);
});
