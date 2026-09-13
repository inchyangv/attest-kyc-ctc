import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListBackedAmlEngine, evidenceDigest } from './engine.js';
import { compareDob } from './identity.js';
import type { SanctionEntry } from './ingest/parse.js';
import type { ScreeningSubject } from './types.js';
import { runIssuance } from '../pipeline/issue.js';
import { KrAdapter } from '../pipeline/adapters/kr.js';
import { SYNTHETIC_SCREENING_ONLY_POLICY } from '../pipeline/identity-policy.js';

// Internal regression fixtures, NOT an independent holdout or a legal match adjudication.
const entry = (extra: Partial<SanctionEntry> = {}): SanctionEntry => ({ listId: 'OFAC_SDN', entryId: 'synthetic-identity-1',
  primaryName: 'Victor Sampleton', names: ['Victor Sampleton'], dobs: ['1980-02-29'], countries: ['KR'],
  cryptoAddresses: [], programs: [], type: 'individual', ...extra });
const subject: ScreeningSubject = { fullName: 'Victor Sampleton', dateOfBirth: '1980-02-29', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '12'.repeat(20) };
const engine = (entries = [entry()]) => new ListBackedAmlEngine({ entries, listVersions: { OFAC_SDN: 123 }, evidenceKey: 'synthetic-identity-regression-key' });

test('DOB comparison preserves full-date precision, calendar validity and explicit list alternatives', () => {
  const cases = [
    ['1980-02-29', ['1980-02-29'], 'match'], ['1980-02-28', ['1980-02-29'], 'conflict'],
    ['1980-12-31', ['1980-02-29'], 'conflict'], ['1980-02-29', ['1980'], 'year-match'],
    ['1980', ['1980-02-29'], 'year-match'], ['1980', ['1980'], 'year-match'],
    ['1981-01-01', ['1980'], 'conflict'], ['1981-02-29', ['1981-02-29'], 'invalid'],
    ['1980-13-01', ['1980-13-01'], 'invalid'], ['1980-02-29', ['1980-13-01'], 'invalid'],
    ['1980-02-29', [], 'missing'], [null, ['1980'], 'missing'],
    ['1980-02-29', ['1979-01-01', '1980-02-29'], 'match'],
    ['1980-02-29', ['1980-01-01', '1980'], 'year-match'],
  ] as const;
  for (const [given, listed, expected] of cases) assert.equal(compareDob(given, [...listed]), expected, JSON.stringify([given, listed]));
});

test('PM-T26-01 same-name/different-DOB-and-country requires review, not automatic block or allow', async () => {
  const result = await engine().screen({ ...subject, dateOfBirth: '1995-08-20', nationality: 'US', residence: 'US' });
  assert.equal(result.decision, 'REVIEW'); assert.equal(result.reviewReason, 'IDENTITY_CONFLICT');
  assert.equal(result.hits[0].score, 1); assert.equal(result.hits[0].corroborated, false);
  assert.deepEqual(result.hits[0].identityComparison, { dob: 'conflict', nationality: 'conflict' });
  assert.equal(result.hits[0].corroboration, undefined);
  assert.equal(result.evidence.checks.find(c => c.id === 'sanctions.name')?.passed, false);
});

test('matching country cannot erase a DOB conflict; matching DOB cannot erase a country conflict', async () => {
  for (const input of [{ ...subject, dateOfBirth: '1980-03-01' }, { ...subject, nationality: 'US' }]) {
    const result = await engine().screen(input);
    assert.equal(result.decision, 'REVIEW'); assert.equal(result.reviewReason, 'IDENTITY_CONFLICT');
    assert.equal(result.hits[0].corroborated, false);
    assert.deepEqual(result.hits[0].corroboration, input.nationality === 'US' ? ['dob'] : ['nationality']);
  }
});

test('year-only/country-only support is traceable but not sufficient for automatic blocking', async () => {
  for (const listed of [entry({ dobs: ['1980'] }), entry({ dobs: [] })]) {
    const result = await engine([listed]).screen(subject);
    assert.equal(result.decision, 'REVIEW'); assert.equal(result.hits[0].corroborated, true);
    assert.equal(result.hits[0].identityComparison?.dob, listed.dobs.length ? 'year-match' : 'missing');
  }
  const result = await engine().screen({ ...subject, dateOfBirth: '1980' });
  assert.equal(result.decision, 'REVIEW'); assert.equal(result.hits[0].identityComparison?.dob, 'year-match');
});

test('name-only support and invalid dates are not fabricated corroboration', async () => {
  const bare = await engine([entry({ dobs: [], countries: [] })]).screen(subject);
  assert.equal(bare.decision, 'REVIEW'); assert.equal(bare.hits[0].corroborated, false);
  assert.deepEqual(bare.hits[0].identityComparison, { dob: 'missing', nationality: 'missing' });
  const invalid = await engine().screen({ ...subject, dateOfBirth: '1980-02-30' });
  assert.equal(invalid.decision, 'REVIEW'); assert.equal(invalid.hits[0].identityComparison?.dob, 'invalid');
  assert.equal(invalid.hits[0].corroborated, false);
});

test('full DOB support without conflict blocks; alternate listed dates and missing nationality remain distinct', async () => {
  for (const listed of [entry(), entry({ dobs: ['1979-01-01', '1980-02-29'] }), entry({ countries: [] })]) {
    const result = await engine([listed]).screen(subject);
    assert.equal(result.decision, 'BLOCK'); assert.equal(result.hits[0].identityComparison?.dob, 'match');
    assert.equal(result.hits[0].corroborated, true);
  }
});

test('a wallet match retains wallet provenance even when the same entry has contradictory name descriptors', async () => {
  const result = await engine([entry({ cryptoAddresses: [subject.walletAddress] })]).screen({ ...subject, dateOfBirth: '1990-01-01', nationality: 'US' });
  assert.equal(result.decision, 'BLOCK'); assert.equal(result.hits[0].matchType, 'wallet');
  assert.deepEqual(result.hits[0].corroboration, ['wallet']); assert.equal(result.hits[0].corroborated, true);
});

test('candidate/display cutoff cannot hide the only corroborated identity after fifty same-name entries', async () => {
  const entries = Array.from({ length: 75 }, (_, i) => entry({ entryId: `synthetic-${i}`, dobs: ['1970-01-01'] }));
  entries.push(entry({ entryId: 'synthetic-last-valid' }));
  const result = await engine(entries).screen(subject);
  assert.equal(result.decision, 'BLOCK'); assert.equal(result.hits.length, 76);
  assert.equal(result.hits[0].entryId, 'synthetic-last-valid');
  assert.equal(result.hits.find(h => h.entryId === 'synthetic-last-valid')?.corroborated, true);
  assert.equal(result.evidence.hitDigests.length, 76);
});

test('comparison evidence changes when identity support changes, stays deterministic and contains no supplied PII', async () => {
  const e = engine(); const a = await e.screen(subject); const b = await e.screen(subject);
  const c = await e.screen({ ...subject, dateOfBirth: '1980-03-01' });
  assert.equal(evidenceDigest(a.evidence), evidenceDigest(b.evidence));
  assert.notEqual(evidenceDigest(a.evidence), evidenceDigest(c.evidence));
  assert.equal(a.engineVersion, 'aml-1.4.0');
  const evidence = JSON.stringify(c.evidence);
  assert.ok(!evidence.includes(subject.fullName)); assert.ok(!evidence.includes('1980-03-01'));
  assert.match(evidence, /dob=conflict/);
});

test('issuance keeps review and denial distinct and creates no positive credential for either', async () => {
  for (const [dateOfBirth, expected] of [['1995-08-20', 'REVIEW'], ['1980-02-29', 'DENIED']] as const) {
    const result = await runIssuance({ wallet: subject.walletAddress,
      declared: { fullName: subject.fullName, dateOfBirth, nationality: 'KR', residence: 'KR' },
      idDocument: null, bankAccount: null, walletControlProven: true, jurisdiction: 410, assurance: 1,
      identityPolicy: SYNTHETIC_SCREENING_ONLY_POLICY,
    }, new KrAdapter(null, null), engine());
    assert.equal(result.status, expected); assert.ok(!('attrs' in result)); assert.ok(!('claimsRoot' in result));
    if (result.status === 'REVIEW') assert.equal(result.reason, 'IDENTITY_CONFLICT');
    assert.match(result.evidenceHash, /^0x[0-9a-f]{64}$/);
  }
});
