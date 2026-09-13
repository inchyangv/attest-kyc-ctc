import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertEvaluation, buildInternalEvaluationReport, type EvaluationMetrics } from './evaluation-gate.js';

const good: EvaluationMetrics = { positiveCount: 200, missed: 0, cleanCount: 610, falsePositive: 0, evasionCount: 7, evasionMissed: 0, walletBlocked: true, unearnedBits: 0 };
test('evaluation gate accepts the fixed internal baseline and rejects each broken metric rather than only printing it', () => {
  assert.doesNotThrow(() => assertEvaluation(good));
  for (const mutation of [{ missed: 1 }, { falsePositive: 1 }, { evasionMissed: 1 }, { walletBlocked: false }, { unearnedBits: 1 },
    { positiveCount: 0 }, { cleanCount: 609 }, { evasionCount: 0 }, { missed: NaN }, { missed: -1 }]) {
    assert.throws(() => assertEvaluation({ ...good, ...mutation }), JSON.stringify(mutation));
  }
});

test('internal evaluation report binds versions, source hashes, sampling, thresholds and statistical limits', () => {
  const report = buildInternalEvaluationReport({
    engineVersion: 'aml-test', sourceSha256: { OFAC_SDN: 'a'.repeat(64) }, listCounts: { OFAC_SDN: 200, total: 200 },
    historical: true, blocked: 168, reviewed: 32, metrics: good, generatedAt: '2026-09-07T00:00:00.000Z',
  });
  assert.equal(report.classification, 'internal-regression-not-independent-holdout');
  assert.equal(report.outcomes.reviewRateAmongPositives, 0.16);
  assert.ok(report.outcomes.falseNegativeWilson95Upper! > 0);
  assert.ok(report.sampleGeneration.positives.includes('matcher source corpus'));
  assert.ok(report.statisticalLimitations.some(limit => limit.includes('not out-of-sample recall')));
  assert.match(report.reportFingerprint, /^[0-9a-f]{64}$/);
});
