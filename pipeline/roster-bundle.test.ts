import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { exportRosterBundle, loadRosterBundle, MAX_BUNDLE_BYTES } from './roster-bundle.js';
import { rosterLeaf, verifyInclusion, verifyNonInclusion } from './roster.js';
import { ROSTER_WITNESS_ABI } from './roster-witness.js';
import { rosterProofServer } from './roster-proof-server.js';
import { bundleFixture } from '../test/fixtures/roster-bundle.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('immutable bundle is deterministic, strips operational fields and yields verified proofs and exact calldata', () => {
  const { record, scope } = bundleFixture();
  const out = exportRosterBundle({ ...record, entries: [...record.entries].reverse() }, scope);
  assert.equal(exportRosterBundle(record, scope).contentHash, out.contentHash);
  const safe = exportRosterBundle({ ...record, rawPII: 'must not distribute' } as typeof record, scope);
  assert.equal(safe.contentHash, out.contentHash);
  assert.ok(!safe.bytes.includes('must not distribute'));
  const loaded = loadRosterBundle(out.bytes, out.contentHash);
  for (const entry of record.entries) {
    const proof = loaded.proof(entry.subject);
    assert.equal(proof.kind, 'inclusion');
    if (proof.kind !== 'inclusion') throw Error('fixture member missing');
    assert.ok(verifyInclusion(proof.root, rosterLeaf(entry), proof.proof));
    const decoded = new ethers.Interface(ROSTER_WITNESS_ABI).decodeFunctionData('cacheRosterWitness', proof.transaction.data);
    assert.equal(decoded.subject, entry.subject);
    assert.equal(proof.transaction.to, scope.registry);
    assert.equal(proof.chainValidation, 'not-performed');
  }
  const absent = loaded.proof(ethers.toBeHex(999, 20));
  assert.equal(absent.kind, 'non-inclusion');
  if (absent.kind === 'non-inclusion') assert.ok(verifyNonInclusion(absent.root, absent.subject, absent.proof));
});

test('bundle rejects wrong pins, tampered roots/entries, unknown schemas, duplicate subjects and raw fields', () => {
  const { record, scope } = bundleFixture(); const out = exportRosterBundle(record, scope);
  assert.throws(() => loadRosterBundle(out.bytes, '0'.repeat(64)), /pin mismatch/);
  assert.throws(() => loadRosterBundle(new Uint8Array(MAX_BUNDLE_BYTES + 1), out.contentHash), /size/);
  for (const change of [ { bundleVersion: 2 }, { epochSchemaVersion: 1 }, { root: ethers.id('fake') }, { epoch: 0 },
    { validUntil: record.sourceCutoff + 86401 }, { publishedAt: record.sourceCutoff - 1 }, { approvedIssuers: [] },
    { entries: [record.entries[0], record.entries[0]] }, { rawPII: 'unexpected' },
    { entries: [{ ...record.entries[0], name: 'unexpected' }] } ]) {
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(out.bytes.toString()), ...change }));
    assert.throws(() => loadRosterBundle(bytes, sha(bytes)));
  }
});

test('caller mutations and later local time do not poison a pinned historical proof or renew its lifetime', () => {
  const { record, scope } = bundleFixture(); const out = exportRosterBundle(record, scope);
  const loaded = loadRosterBundle(out.bytes, out.contentHash);
  const initial = loaded.proof(record.entries[0].subject);
  const altered = loaded.proof(record.entries[0].subject);
  altered.scope.registry = ethers.ZeroAddress;
  if (altered.kind === 'inclusion') { altered.mark.attrs = ethers.ZeroHash; altered.proof.siblings[0] = ethers.ZeroHash; }
  assert.deepEqual(loaded.proof(record.entries[0].subject), initial);
  assert.equal(loaded.metadata().validUntil, record.validUntil);
  assert.equal(loaded.metadata().chainValidation, 'not-performed');
});

test('empty roster sentinel proofs and binary-search boundaries work across a larger immutable tree', () => {
  for (const count of [0, 1, 127]) {
    const { record, scope } = bundleFixture(count); const out = exportRosterBundle(record, scope);
    const loaded = loadRosterBundle(out.bytes, out.contentHash);
    for (const n of [1000, 2000, 3000, 4000, 5000]) {
      const proof = loaded.proof(ethers.toBeHex(n, 20));
      assert.equal(proof.kind, 'non-inclusion');
      if (proof.kind === 'non-inclusion') assert.ok(verifyNonInclusion(proof.root, proof.subject, proof.proof));
    }
    assert.throws(() => loaded.proof(ethers.ZeroAddress), /invalid/);
  }
});

test('independent file replica serves proofs after original publisher artifact removal with no RPC or keys', async t => {
  const { record, scope } = bundleFixture(); const out = exportRosterBundle(record, scope);
  const directory = mkdtempSync(join(tmpdir(), 'proofmark-bundle-replica-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const origin = join(directory, 'origin.json'), replica = join(directory, 'replica.json');
  writeFileSync(origin, out.bytes, { flag: 'wx' });
  writeFileSync(replica, readFileSync(origin), { flag: 'wx' });
  unlinkSync(origin); // Only this test's synthetic origin artifact is removed.
  const server = rosterProofServer(loadRosterBundle(readFileSync(replica), out.contentHash));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = `/v1/rosters/${out.contentHash}/proof/${record.entries[0].subject}`;
  const response = await fetch(base + path);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /immutable/);
  const body = await response.json();
  assert.equal(body.chainValidation, 'not-performed');
  assert.equal(body.kind, 'inclusion');
  assert.ok(verifyInclusion(body.root, rosterLeaf(record.entries[0]), body.proof));
  assert.equal((await fetch(base + path, { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + path, { headers: { Origin: 'https://untrusted.invalid' } })).status, 400);
  assert.equal((await fetch(base + path + '?file=/etc/passwd')).status, 404);
  assert.equal((await fetch(base + path.replace(out.contentHash, '0'.repeat(64)))).status, 404);
  for (let i = 0; i < 116; ++i) await fetch(base + '/not-found');
  assert.equal((await fetch(base + path)).status, 429);
});
