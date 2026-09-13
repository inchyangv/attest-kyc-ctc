/**
 * Property tests for the engine. CI holds the evaluation numbers in place.
 * Requires the three source lists in data/raw.
 */
import { test, before } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { loadHistoricalLists as loadLists } from './loader.js';
import { ListBackedAmlEngine, evidenceDigest } from './engine.js';
import { nameScore } from './match.js';
import { M } from './types.js';

const HAVE_LISTS = existsSync('data/raw/current.json') || existsSync('data/raw/ofac_sdn.xml');
let engine: ListBackedAmlEngine;
let entries: Awaited<ReturnType<typeof loadLists>>['entries'];

before(async () => {
  if (!HAVE_LISTS) return;
  const l = await loadLists();
  entries = l.entries;
  engine = new ListBackedAmlEngine({ entries, listVersions: l.listVersions, evidenceKey: 'test-only-evidence-key', keyId: 'test-k1' });
});

const clean = { dateOfBirth: '1985-03-14', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '2'.repeat(40) };

test('listed EVM wallet indexing is case-insensitive even when a corpus bypasses XML normalization', async () => {
  const address = '0x' + 'aB'.repeat(20);
  for (const listed of [address, address.toLowerCase(), '0x' + address.slice(2).toUpperCase()]) {
    const local = new ListBackedAmlEngine({ entries: [{ listId: 'OFAC_SDN', entryId: 'FICTIONAL-MIXED-CASE',
      primaryName: 'Zorvax Quenlith', names: ['Zorvax Quenlith'], dobs: [], countries: [], programs: [],
      cryptoAddresses: [listed], type: 'individual' }], listVersions: { OFAC_SDN: 1 }, evidenceKey: 'synthetic-wallet-index-key' });
    for (const walletAddress of [address, address.toLowerCase()]) {
      const result = await local.screen({ ...clean, fullName: 'Unrelated Fictional Name', walletAddress });
      assert.equal(result.decision, 'BLOCK');
      assert.ok(result.hits.some(hit => hit.matchType === 'wallet'));
      assert.equal(result.methodsApplied & M.ONCHAIN_EXPOSURE, 0);
    }
    assert.equal((await local.screen({ ...clean, fullName: 'Unrelated Fictional Name' })).decision, 'ALLOW');
  }
});

test('no containment bonus for short names, the source of the 33% false positives', () => {
  assert.ok(nameScore(['ji'], ['ji']) <= 1);
  // a partial overlap between two-token names must not land near full marks
  assert.ok(nameScore(['kim','chol'], ['chol','ri']) < 0.5, 'two-token partial overlap is scoring too high');
  // at three tokens and up the bonus must survive, or recall drops
  assert.ok(nameScore(['kim','jong','un'], ['kim','jong','un','marshal']) > 0.8);
});

test('recall: every listed individual is caught by their own details', { skip: !HAVE_LISTS }, async () => {
  const inds = entries.filter(e => e.type === 'individual' && e.dobs.length && e.countries.length && e.primaryName.split(/\s+/).length >= 2);
  const step = Math.max(1, Math.floor(inds.length / 100));
  const sample = inds.filter((_, i) => i % step === 0).slice(0, 100);
  let caught = 0;
  for (const e of sample) {
    const r = await engine.screen({
      fullName: e.primaryName,
      dateOfBirth: e.dobs[0].length === 4 ? `${e.dobs[0]}-01-01` : e.dobs[0],
      nationality: e.countries[0], residence: e.countries[0], walletAddress: '0x' + '1'.repeat(40),
    });
    if (r.decision !== 'ALLOW') caught++;
  }
  assert.equal(caught, sample.length, `${sample.length - caught} slipped through; recall must stay at 100%`);
});

test('specificity: no false positives across 600 ordinary Korean names', { skip: !HAVE_LISTS }, async () => {
  const SUR = ['\uAE40','\uC774','\uBC15','\uCD5C','\uC815','\uAC15','\uC870','\uC724','\uC7A5','\uC784','\uD55C','\uC624','\uC11C','\uC2E0','\uAD8C','\uD669','\uC548','\uC1A1','\uC804','\uD64D','\uC720','\uACE0','\uBB38','\uC591','\uC190','\uBC30','\uBC31','\uD5C8','\uC2EC','\uB178'];
  const GIV = ['\uCCA0\uC218','\uC601\uD76C','\uBBFC\uC900','\uC11C\uC5F0','\uC6B0\uC9C4','\uC9C0\uD6C8','\uD604\uC6B0','\uC11C\uC900','\uD558\uC740','\uB3C4\uC724','\uC9C0\uBBFC','\uC138\uD6C8','\uC9C0\uC6B0','\uC608\uC740','\uB098\uC740','\uBBFC\uC11C','\uC900\uD638','\uC7AC\uD604','\uB2E4\uC778','\uC2B9\uC6B0'];
  const fps: string[] = [];
  for (const s of SUR) for (const g of GIV) {
    const r = await engine.screen({ fullName: s + g, ...clean });
    if (r.decision !== 'ALLOW') fps.push(`${s}${g}→${r.decision}`);
  }
  assert.equal(fps.length, 0, `${fps.length} false positive(s): ${fps.slice(0, 5).join(', ')}`);
});

test('a corroborated Hangul name is caught through romanised expansion', { skip: !HAVE_LISTS }, async () => {
  const r = await engine.screen({ fullName: '\uAE40\uC815\uC740', dateOfBirth: '1984-01-08', nationality: 'KP', residence: 'KP', walletAddress: '0x' + '3'.repeat(40) });
  assert.equal(r.decision, 'BLOCK');
  assert.equal(r.riskBand, 5);
});

test('an uncorroborated expansion hit does not hold anyone, but it is recorded', { skip: !HAVE_LISTS }, async () => {
  const r = await engine.screen({ fullName: '\uCD5C\uC601\uD638', ...clean });
  assert.equal(r.decision, 'ALLOW', 'our own inference must not block a person on its own');
  assert.ok(r.hits.length > 0, 'the hit itself must be recorded for the audit trail');
  assert.equal(r.hits[0].corroborated, false);
});

test('evasion: homoglyphs, invisible characters, diacritics, word order', { skip: !HAVE_LISTS }, async () => {
  const t = entries.find(e => e.type === 'individual' && e.dobs.length && e.countries.length && /^[a-zA-Z ]+$/.test(e.primaryName) && e.primaryName.split(' ').length >= 3)!;
  const dob = t.dobs[0].length === 4 ? `${t.dobs[0]}-01-01` : t.dobs[0];
  const variants = [
    t.primaryName,
    t.primaryName.split('').join('​'),
    t.primaryName.replace(/a/gi, 'а').replace(/e/gi, 'е'),
    t.primaryName.replace(/a/gi, 'á'),
    t.primaryName.split(' ').reverse().join(' '),
  ];
  for (const v of variants) {
    const r = await engine.screen({ fullName: v, dateOfBirth: dob, nationality: t.countries[0], residence: t.countries[0], walletAddress: '0x' + '4'.repeat(40) });
    assert.equal(r.decision, 'BLOCK', `evasion passed: ${JSON.stringify(v)}`);
  }
});

test('a sanctioned wallet is blocked regardless of the name', { skip: !HAVE_LISTS }, async () => {
  const e = entries.find(x => x.cryptoAddresses.some(a => /^0x[0-9a-f]{40}$/.test(a)))!;
  const addr = e.cryptoAddresses.find(a => /^0x[0-9a-f]{40}$/.test(a))!;
  const r = await engine.screen({ fullName: 'Totally Unrelated', dateOfBirth: '1990-01-01', nationality: 'US', residence: 'US', walletAddress: addr });
  assert.equal(r.decision, 'BLOCK');
  assert.equal(r.hits[0].matchType, 'wallet');
});

test('screening that did not run leaves its bit unset', { skip: !HAVE_LISTS }, async () => {
  const r = await engine.screen({ fullName: 'Test Person', ...clean });
  assert.ok((r.methodsApplied & M.SANCTIONS_SCREENED) !== 0, 'we screened against real lists, so this is set');
  assert.equal(r.methodsApplied & M.ONCHAIN_EXPOSURE, 0, 'listed wallet lookup is not exposure analysis');
  assert.equal(r.methodsApplied & M.PEP_SCREENED, 0, 'setting this bit without PEP data would be a lie');
  assert.equal(r.methodsApplied & M.ADVERSE_MEDIA, 0);
});

test('evidence is deterministic: same input, same digest', { skip: !HAVE_LISTS }, async () => {
  const s = { fullName: '\uD64D\uAE38\uB3D9', ...clean };
  const a = await engine.screen(s), b = await engine.screen(s);
  assert.equal(evidenceDigest(a.evidence), evidenceDigest(b.evidence));
  assert.ok(a.evidence.engineVersion.startsWith('aml-'));
});
