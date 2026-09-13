import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FATF, assertJurisdictionTable, fatfFreshnessDays, jurisdictionRisk, jurisdictionTableId,
  type JurisdictionTable,
} from './jurisdiction.js';

const rehash = (value: JurisdictionTable): JurisdictionTable => {
  const { snapshotId: _snapshotId, ...body } = value;
  return { ...body, snapshotId: jurisdictionTableId(body) };
};

test('FATF June 2026 statements are an independently versioned and bounded observation', () => {
  const checked = Date.parse(FATF.verifiedAt);
  assertJurisdictionTable(FATF, checked + 120 * 86_400_000);
  assert.throws(() => assertJurisdictionTable(FATF, checked + 120 * 86_400_000 + 1), /INVALID_OR_STALE/);
  assert.equal(jurisdictionRisk('KP').level, 2);
  assert.equal(jurisdictionRisk('BA').level, 1);
  assert.equal(jurisdictionRisk('KR').level, 0);
  assert.deepEqual(FATF.callForAction, ['KP', 'IR', 'MM']);
  assert.deepEqual(FATF.increasedMonitoring, [
    'AO','BO','BA','BG','CM','CI','CD','HT','IQ','KE','KW','LA','LB','MC','NP','PG','SS','SY','VE','VN','VG','YE',
  ]);
  for (const value of ['0', '-1', '181', 'Infinity', 'NaN', '']) assert.throws(() => fatfFreshnessDays(value));
});

test('FATF future checks, source drift, overlap and edits without a new table ID fail closed', () => {
  const now = Date.parse(FATF.verifiedAt) + 1;
  const changed = structuredClone(FATF); changed.increasedMonitoring.pop();
  assert.throws(() => assertJurisdictionTable(changed, now), /INVALID_OR_STALE/);
  const overlap = structuredClone(FATF); overlap.increasedMonitoring.push('KP');
  assert.throws(() => assertJurisdictionTable(rehash(overlap), now), /INVALID_OR_STALE/);
  const source = structuredClone(FATF); source.sources.callForAction = 'https://example.invalid';
  assert.throws(() => assertJurisdictionTable(rehash(source), now), /INVALID_OR_STALE/);
  const future = structuredClone(FATF); future.verifiedAt = new Date(now + 1).toISOString();
  assert.throws(() => assertJurisdictionTable(rehash(future), now), /INVALID_OR_STALE/);
});
