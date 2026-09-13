import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedEditDistance, deletionKeys, editNameScore, missingTokenNameScore, supportedEditLimit, withinOneEdit, withinSupportedEdits } from './edit-distance.js';
import { ListBackedAmlEngine, evidenceDigest } from './engine.js';
import { AmlMatchCapacityError, buildCorpus, screenNames } from './match.js';
import type { SanctionEntry } from './ingest/parse.js';

const entry = (name = 'Victor Sampleton', id = 'synthetic-edit'): SanctionEntry => ({ listId: 'OFAC_SDN', entryId: id,
  primaryName: name, names: [name], dobs: ['1980-02-29'], countries: ['KR'], programs: [], cryptoAddresses: [], type: 'individual' });
const input = { fullName: 'Victor Sampleton', dateOfBirth: '1980-02-29', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '12'.repeat(20) };
const engine = (entries = [entry()]) => new ListBackedAmlEngine({ entries, listVersions: { OFAC_SDN: 123 }, evidenceKey: 'synthetic-edit-distance-key' });

test('single-edit verifier and deletion retrieval agree for substitution, insertion, deletion and transposition', () => {
  for (const variant of ['viktor', 'victorr', 'vctor', 'vicotr', 'xvictor', 'victorx']) {
    assert.ok(withinOneEdit('victor', variant)); assert.ok(withinOneEdit(variant, 'victor'));
    assert.ok(deletionKeys('victor').some(k => deletionKeys(variant).includes(k)), variant);
  }
  for (const variant of ['viktox', 'other', 'vi', 'v'.repeat(49)]) assert.equal(withinOneEdit('victor', variant), false);
  assert.equal(withinOneEdit('kim', 'kam'), false, 'short tokens are exact-only');
  assert.deepEqual(deletionKeys('kim'), []);
  assert.equal(withinOneEdit('김영희'.normalize('NFD'), '김경희'.normalize('NFD')), false, 'decomposed jamo cannot inflate a short name');
  assert.deepEqual(deletionKeys('김영희'.normalize('NFD')), []);
});

test('bounded Unicode distance covers two edits without widening short or oversized tokens', () => {
  for (const [left, right] of [['victor', 'wiktor'], ['sampleton', 'sampton'], ['abcdefghi', 'bacdfeghi'], ['victor', 'vicxtorq']]) {
    assert.equal(boundedEditDistance(left, right, 2), 2, `${left}/${right}`);
    assert.equal(withinSupportedEdits(left, right), true, `${left}/${right}`);
  }
  assert.equal(supportedEditLimit('kim'), 0);
  assert.equal(supportedEditLimit('park'), 1);
  assert.equal(supportedEditLimit('victor'), 2);
  assert.equal(supportedEditLimit('x'.repeat(64)), 2);
  assert.equal(supportedEditLimit('x'.repeat(65)), 0);
  assert.equal(withinSupportedEdits('kim', 'kam'), false);
  assert.equal(withinSupportedEdits('x'.repeat(65), `${'x'.repeat(64)}y`), false);
});

test('reported spelling evasion and every supported edit class reaches review/block with identity evidence', async () => {
  const e = engine();
  for (const fullName of ['Viktor Sampleton', 'Victorr Sampleton', 'Vctor Sampleton', 'Vicotr Sampleton', 'Viktor Sampelton']) {
    const result = await e.screen({ ...input, fullName });
    assert.notEqual(result.decision, 'ALLOW', fullName);
    assert.equal(result.hits[0].entryId, 'synthetic-edit');
    assert.notEqual(result.hits[0].matchType, 'exact');
    assert.equal(result.hits[0].identityComparison?.dob, 'match');
  }
});

test('both tokens may be misspelled without sharing any exact token; score remains a name score', async () => {
  const result = await engine().screen({ ...input, fullName: 'Viktor Sampelton', dateOfBirth: '1995-08-20', nationality: 'US' });
  assert.equal(result.decision, 'REVIEW'); assert.equal(result.reviewReason, 'IDENTITY_CONFLICT');
  assert.equal(result.hits[0].corroborated, false); assert.ok(result.hits[0].score >= 0.82);
});

test('PM-T25-01 retrieves bounded two-edit tokens, one omitted name part and the supported long-token boundary', async () => {
  const threePart = engine([entry('Victor Alexander Sampleton')]);
  for (const fullName of ['Wiktor Alexander Sampleton', 'Victor Sampleton']) {
    const result = await threePart.screen({ ...input, fullName });
    assert.notEqual(result.decision, 'ALLOW', fullName);
    assert.equal(result.hits[0]?.entryId, 'synthetic-edit');
  }

  const listedToken = 'a'.repeat(63) + 'b';
  const queriedToken = 'a'.repeat(62) + 'cb';
  const result = await engine([entry(`Victor ${listedToken}`)]).screen({ ...input, fullName: `Victor ${queriedToken}` });
  assert.notEqual(result.decision, 'ALLOW');
  assert.equal(result.hits[0]?.entryId, 'synthetic-edit');
});

test('two-edit retrieval covers substitution, insertion, deletion and two transpositions', async () => {
  for (const [listed, supplied] of [['Victor Sampleton', 'Wiktor Sampleton'], ['Vicxtorq Sampleton', 'Victor Sampleton'],
    ['Sampleton Victor', 'Sampton Victor'], ['Abcdefghi Sampleton', 'Bacdfeghi Sampleton']]) {
    const result = await engine([entry(listed)]).screen({ ...input, fullName: supplied });
    assert.notEqual(result.decision, 'ALLOW', `${listed}/${supplied}`);
  }
});

test('one missing part is review-level, while a one-token fragment is not promoted to a name match', async () => {
  assert.equal(missingTokenNameScore(['victor', 'sampleton'], ['victor', 'alexander', 'sampleton']), 0.82);
  assert.equal(missingTokenNameScore(['sampleton'], ['victor', 'sampleton']), 0);
  const local = engine([entry('Victor Alexander Sampleton')]);
  const partial = await local.screen({ ...input, fullName: 'Victor Sampleton' });
  assert.equal(partial.decision, 'REVIEW'); assert.equal(partial.hits[0].score, 0.82);
  const fragment = await local.screen({ ...input, fullName: 'Sampleton' });
  assert.equal(fragment.decision, 'ALLOW'); assert.equal(fragment.hits.length, 0);
});

test('short and >64-code-point tokens are measured as exact-only boundaries', async () => {
  const short = engine([entry('Li Na')]);
  assert.equal((await short.screen({ ...input, fullName: 'Li Na' })).decision, 'BLOCK');
  assert.equal((await short.screen({ ...input, fullName: 'Lu Na' })).decision, 'ALLOW');
  const token = 'x'.repeat(65);
  const long = engine([entry(`Victor ${token}`)]);
  assert.equal((await long.screen({ ...input, fullName: `Victor ${token}` })).decision, 'BLOCK');
  assert.equal((await long.screen({ ...input, fullName: `Victor ${'x'.repeat(64)}y` })).decision, 'ALLOW');
});

test('candidate and index overloads fail closed instead of truncating to an ALLOW result', () => {
  const dense = Array.from({ length: 4 }, (_, i) => entry(`Victor Dense${i}`, `dense-${i}`));
  const limited = buildCorpus(dense, { maxCandidateNames: 2 });
  assert.throws(() => screenNames(limited, { fullName: 'Victor Dense0', dob: '1980-02-29', nationality: 'KR', walletAddress: '' }),
    (error: unknown) => error instanceof AmlMatchCapacityError && error.code === 'AML_MATCH_CAPACITY');
  assert.throws(() => buildCorpus(dense, { maxIndexNames: 2 }), /AML_MATCH_CAPACITY: index names/);
});

test('exact matches made solely of old stop tokens and >4000-frequency tokens are not dropped', async () => {
  assert.equal((await engine([entry('Ali Hassan')]).screen({ ...input, fullName: 'Ali Hassan' })).decision, 'BLOCK');
  const entries = Array.from({ length: 4001 }, (_, i) => ({ ...entry('Victor Sampleton', `dense-${i}`), dobs: ['1970-01-01'] }));
  entries.push(entry());
  const result = await engine(entries).screen(input);
  assert.equal(result.decision, 'BLOCK'); assert.equal(result.hits.length, 4002); assert.equal(result.hits[0].entryId, 'synthetic-edit');
});

test('one-edit score uses each token once and does not turn one shared short fragment into a full name', () => {
  assert.equal(editNameScore(['kim', 'chol'], ['chol', 'ri']), 0.5);
  assert.ok(editNameScore(['victor', 'viktor'], ['victor', 'unrelated']) < 0.82);
  assert.equal(editNameScore(['victor', 'sampleton'], ['sampleton', 'victor']), 1);
  assert.equal(editNameScore(['viktor', 'sampelton'], ['sampleton', 'victor']), editNameScore(['sampelton', 'viktor'], ['victor', 'sampleton']));
});

test('provided romanization cannot suppress an original native-script match; aliases remain searchable', () => {
  const corpus = buildCorpus([{ ...entry('박서준'), names: ['박서준', 'Victor Sampleton'] }]);
  const hits = screenNames(corpus, { fullName: '박서준', romanizedName: 'Completely Unrelated', dob: '1980-02-29', nationality: 'KR', walletAddress: '' });
  assert.equal(hits[0].entryId, 'synthetic-edit'); assert.equal(hits[0].score, 1);
  const alias = screenNames(corpus, { fullName: 'Viktor Sampleton', dob: '1980-02-29', nationality: 'KR', walletAddress: '' });
  assert.equal(alias[0].matchType, 'alias');
});

test('synthetic non-Latin single-edit cases use code points, without claiming phonetic equivalence', async () => {
  for (const [listed, variant] of [['Александр Петрович', 'Александп Петрович'], ['عبدالرحمن منصوري', 'عبدالرحمن منصورب'], ['가나다라마 바사아자차', '가나다라마 바사아자카']]) {
    const result = await engine([entry(listed)]).screen({ ...input, fullName: variant });
    assert.notEqual(result.decision, 'ALLOW', variant);
  }
});

test('a higher inferred hit cannot erase a decision-driving supplied name; both inputs affect evidence', async () => {
  const e = engine([entry('Jong Un Kim')]);
  const result = await e.screen({ ...input, fullName: '김정은', romanizedName: 'Kim Jong Un Marshal', dateOfBirth: '1995-08-20', nationality: 'US' });
  assert.equal(result.decision, 'REVIEW'); assert.ok((result.hits[0].directNameScore ?? 0) >= 0.82);
  assert.equal(result.hits[0].matchType, 'romanized'); assert.equal(result.hits[0].inferredNameScore, 1);
  const a = await engine().screen({ ...input, romanizedName: 'Unrelated Name' });
  const b = await engine().screen({ ...input, fullName: 'Other Person', romanizedName: 'Unrelated Name' });
  assert.notEqual(evidenceDigest(a.evidence), evidenceDigest(b.evidence));
});
