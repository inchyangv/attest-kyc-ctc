import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedEpochParams, requireEpochV2 } from './epoch.js';
import { LIST_IDS, PARSER_VERSION, SOURCES, snapshotId, publicEffectiveUrl, sha256, type ListProvenance, type SourceEvidence } from '../aml/provenance.js';

function provenance(now: number): ListProvenance {
  const at = new Date(now).toISOString();
  const sources = Object.fromEntries(LIST_IDS.map(id => [id, { sourceUrl: SOURCES[id].url, effectiveUrl: publicEffectiveUrl(SOURCES[id].url), effectiveUrlSha256: sha256(SOURCES[id].url),
    fetchedAt: at, checkedAt: at, publishedAt: null, httpLastModified: null, sha256: '1'.repeat(64), bytes: 100, entryCount: 1 }])) as Record<typeof LIST_IDS[number], SourceEvidence>;
  const body = { v: 2 as const, parserVersion: PARSER_VERSION, createdAt: at, sources };
  return { ...body, snapshotId: snapshotId(body) };
}

test('epoch lifetime is cutoff-anchored and carries the full manifest binding, not a configurable fake list version', () => {
  const now = 1_800_000_000_000, cutoff = now / 1000 - 3600, p = provenance(now);
  const result = boundedEpochParams(cutoff, p, now);
  assert.equal(result.validUntil, cutoff + 86400);
  assert.equal(result.sourceCutoff, cutoff);
  assert.equal(result.snapshotId, '0x' + p.snapshotId);
  assert.equal(result.listVersion, parseInt(p.snapshotId.slice(0, 8), 16));
  assert.equal(boundedEpochParams(now / 1000, p, now, '0.5').validUntil, now / 1000 + 1800);
});

test('future/old cutoff, expired or excessive lifetime, and stale/future sanctions evidence reject publication planning', () => {
  const now = 1_800_000_000_000, at = now / 1000, p = provenance(now);
  for (const cutoff of [0, at + 1, at - 3601, at - 0.5, NaN]) assert.throws(() => boundedEpochParams(cutoff, p, now));
  for (const hours of ['0', '-1', '', '25', 'Infinity', '0.00001']) assert.throws(() => boundedEpochParams(at, p, now, hours));
  assert.throws(() => boundedEpochParams(at - 3600, p, now, '1'), /expired/);
  assert.throws(() => boundedEpochParams(at, provenance(now - 86400001), now), /stale/);
  assert.throws(() => boundedEpochParams(at, provenance(now + 1), now), /future/);
});

test('an aging sanctions snapshot cannot be repackaged into a fresh 24-hour epoch', () => {
  const now = 1_800_000_000_000, at = now / 1000;
  const almostStale = boundedEpochParams(at, provenance(now - 23 * 3_600_000), now);
  assert.equal(almostStale.validUntil, at + 3_600);
  assert.equal(almostStale.validDays, 1 / 24);
  assert.throws(() => boundedEpochParams(at, provenance(now - 24 * 3_600_000), now), /expired/);
});

test('every epoch target must advertise v2; old/missing source cannot be hidden by a new ASC', async () => {
  await requireEpochV2(async () => 2n, async () => 2n);
  for (const value of [0, 1, 3, undefined, null]) await assert.rejects(requireEpochV2(async () => 2n, async () => value), /unsupported/);
  await assert.rejects(requireEpochV2(async () => { throw new Error('missing getter'); }, async () => 2n), /unavailable/);
});
