import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { loadHistoricalLists as loadLists } from './loader.js';
import { ListBackedAmlEngine } from './engine.js';
import { containsPii } from '../pipeline/pii-guard.js';

const HAVE = existsSync('data/raw/current.json') || existsSync('data/raw/ofac_sdn.xml');

// pipeline/pii-guard.ts owns the detector. A second copy would drift.
const leaks = (h: unknown, n: string) => containsPii(h, n);

test('evidence carries no cleartext name, checked across NFC and NFD', { skip: !HAVE }, async () => {
  const { entries, listVersions } = await loadLists();
  const e = new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'k', keyId: 't' });
  const name = '\uBC15\uC11C\uC900';
  const r = await e.screen({ fullName: name, dateOfBirth: '1990-05-05', nationality: 'KR', residence: 'KR', walletAddress: '0x'+'9'.repeat(40) });
  const ev = JSON.stringify(r.evidence);
  assert.equal(leaks(ev, name), false, 'a cleartext name survived in the evidence');
  for (const t of ['bak','seo','jun','park']) assert.equal(leaks(ev, t), false, 'romanised fragment "${t}" leaked');
  assert.ok(r.evidence.nameDigest.startsWith('0x'));
  assert.ok(r.evidence.variantDigests.length > 0, 'expansion digests must survive or matching is not reproducible');
});

test('the detector itself works: a naive includes misses NFD', () => {
  const nfd = '\uBC15\uC11C\uC900'.normalize('NFD');
  assert.equal(nfd.includes('\uBC15\uC11C\uC900'), false, 'premise: the naive comparison fails');
  assert.equal(leaks(nfd, '\uBC15\uC11C\uC900'), true, 'the detector must catch it');
});

test('a different evidence key gives a different digest, so these are not unsalted hashes', { skip: !HAVE }, async () => {
  const { entries, listVersions } = await loadLists();
  const s = { fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x'+'8'.repeat(40) };
  const a = await new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'key-A' }).screen(s);
  const b = await new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'key-B' }).screen(s);
  assert.notEqual(a.evidence.nameDigest, b.evidence.nameDigest);
});

test('the engine refuses to start without a key', () => {
  assert.throws(() => new ListBackedAmlEngine({ entries: [], listVersions: {}, evidenceKey: '' }));
});
