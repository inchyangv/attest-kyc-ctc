import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSanctionsTraining } from './sanctions-training.js';
import { isTrainingResult, TRAINING_SCENARIOS } from './sanctions-training-model.js';

test('actual matcher and decision engine distinguish fictional match, missing descriptors, conflict and no match', async () => {
  const matched = await runSanctionsTraining('full-match');
  assert.equal(matched.trainingDecision, 'BLOCK'); assert.deepEqual(matched.comparisons, [{ score: 1, dateOfBirth: 'match', nationality: 'match' }]);
  const name = await runSanctionsTraining('name-only');
  assert.equal(name.trainingDecision, 'REVIEW'); assert.equal(name.comparisons[0].dateOfBirth, 'missing');
  const conflict = await runSanctionsTraining('dob-conflict');
  assert.equal(conflict.trainingDecision, 'REVIEW'); assert.equal(conflict.comparisons[0].dateOfBirth, 'conflict');
  assert.match(conflict.explanation, /not an automatic block or clearance/);
  const clean = await runSanctionsTraining('no-match'); assert.equal(clean.trainingDecision, 'ALLOW'); assert.deepEqual(clean.comparisons, []);
});

test('fixed inputs reject arbitrary scenarios and output mutation cannot change the next run', async () => {
  for (const value of [undefined, null, '', 'allow', 'constructor', '__proto__', {}, { scenario: 'full-match', fullName: 'Private Name' }]) {
    await assert.rejects(runSanctionsTraining(value));
  }
  const a = await runSanctionsTraining('full-match'); a.fixture.datesOfBirth[0] = '1900-01-01'; a.subject.name = 'mutated';
  const b = await runSanctionsTraining('full-match'); assert.equal(b.subject.name, 'Zorvax Quenlith');
  assert.deepEqual(b.fixture.datesOfBirth, ['2000-01-01']); assert.equal(a.dataset.sha256, b.dataset.sha256);
  for (const scenario of TRAINING_SCENARIOS) assert.equal((await runSanctionsTraining(scenario)).dataset.sha256, b.dataset.sha256);
});

test('training projection never claims official screening or exports evidence, method bits or credential material', async () => {
  for (const scenario of TRAINING_SCENARIOS) {
    const r = await runSanctionsTraining(scenario); assert.equal(isTrainingResult(r, scenario), true);
    assert.equal(r.scope, 'synthetic-training-only'); assert.equal(r.eligibleForIssuance, false);
    const text = JSON.stringify(r);
    for (const forbidden of ['OFAC_SDN', 'UN_CONSOLIDATED', 'EU_FSF', 'listVersions', 'sourceSnapshot', 'evidenceKey',
      'methodsApplied', 'walletProof', 'idProof', 'bankProof', 'evidenceHash', 'claimsRoot', 'txHash']) assert.ok(!text.includes(forbidden), forbidden);
    assert.equal(r.officialListsChecked, false); assert.equal(r.credentialCreated, false);
  }
});

test('display guard rejects real-screening shapes, wrong scope/scenario and malformed comparisons', async () => {
  const r = await runSanctionsTraining('full-match');
  for (const value of [null, {}, { decision: 'ALLOW' }, { ...r, scope: 'production' }, { ...r, eligibleForIssuance: true },
    { ...r, officialListsChecked: true }, { ...r, credentialCreated: true }, { ...r, scenario: 'no-match' },
    { ...r, dataset: null }, { ...r, comparisons: [null] }, { ...r, comparisons: [{ score: Infinity }] }]) {
    assert.equal(isTrainingResult(value, 'full-match'), false);
  }
});
