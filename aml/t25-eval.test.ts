import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateT25Synthetic, T25_SYNTHETIC_MATRIX } from './t25-eval.js';

test('T-25 synthetic matrix reports supported recall and clean holds separately from declared boundaries', async () => {
  const result = await evaluateT25Synthetic();
  assert.equal(result.total, T25_SYNTHETIC_MATRIX.length);
  assert.equal(result.supportedEscalations, 12);
  assert.equal(result.supportedMissed, 0);
  assert.equal(result.supportedAllows, 2);
  assert.equal(result.supportedFalseHolds, 0);
  assert.equal(result.boundaryOrUnmodeled, 5);
  for (const group of [...Object.values(result.byCategory), ...Object.values(result.byLanguage)]) assert.equal(group.passed, group.total);
  assert.equal(result.dataset, 'internal-synthetic-regression-not-independent-holdout');
});
