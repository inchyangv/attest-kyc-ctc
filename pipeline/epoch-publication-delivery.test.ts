import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { EpochPublicationJournal } from './epoch-publication-journal.js';
import { PUBLICATION_ABI, advancePublication, reobservePublication, type PublicationObservation, type PublicationTransport } from './epoch-publication-delivery.js';

const signer = new ethers.Wallet('0x' + '01'.padStart(64, '0'));
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'proofmark-publication-step-'));
  const source = '0x' + 'ab'.repeat(20), path = join(dir, 'journal.enc');
  const journal = new EpochPublicationJournal(path, 'synthetic-step-secret-at-least-32-characters', { chainId: 11155111, source, publisher: signer.address });
  t.after(() => { try { journal.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const entry = journal.begin({ calldata: PUBLICATION_ABI.encodeFunctionData('publishEpoch', [1, ethers.id('root'), 1, 1800086400, 1800000000, ethers.id('snapshot')]),
    sourceCutoff: { blockNumber: 10, blockHash: ethers.id('cutoff') }, createdAt: 100 });
  let observation: PublicationObservation = { state: 'absent' };
  const calls = { prepare: 0, broadcast: 0, ready: 0 };
  const transport: PublicationTransport = {
    observe: async () => observation,
    assertReady: async () => { calls.ready++; },
    prepare: async e => { calls.prepare++; return signer.signTransaction({ chainId: 11155111, to: source, nonce: 0, value: 0, data: e.intent.calldata, gasLimit: 250000, gasPrice: 1 }); },
    broadcast: async e => { calls.broadcast++; assert.equal(journal.snapshot()[0].transaction!.raw, e.transaction!.raw); },
  };
  return { path, entry, journal, calls, transport, observe: (value: PublicationObservation) => { observation = value; } };
}

test('publication signature persistence failure fences the network send and keeps its recovery lock', async t => {
  const f = fixture(t), sync = fs.fsyncSync;
  const hook = t.mock.method(fs, 'fsyncSync', (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('SYNTHETIC_IO'); sync(fd); });
  try { await assert.rejects(advancePublication(f.journal, f.entry.id, f.transport), /PUBLICATION_WRITE_UNCONFIRMED/); }
  finally { hook.mock.restore(); }
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 0);
  f.journal.close(); assert.equal(fs.existsSync(`${f.path}.lock`), true);
});

test('publication rechecks readiness and late receipts after signing without sending a stale or shallow-confirmed intent', async t => {
  for (const scenario of ['closed', 'readiness', 'receipt'] as const) {
    const f = fixture(t); let checks = 0;
    f.transport.assertReady = async () => {
      checks++;
      if (scenario === 'closed') f.journal.close();
      if (checks === 2 && scenario === 'readiness') throw new Error('SYNTHETIC_SNAPSHOT_CHANGED');
      if (checks === 2 && scenario === 'receipt') f.observe({ state: 'confirming' });
    };
    const run = advancePublication(f.journal, f.entry.id, f.transport);
    if (scenario === 'receipt') assert.equal((await run).state, 'confirming');
    else await assert.rejects(run, scenario === 'closed' ? /PUBLICATION_JOURNAL_CLOSED/ : /SYNTHETIC_SNAPSHOT_CHANGED/);
    assert.equal(f.calls.broadcast, 0); assert.equal(f.calls.prepare, scenario === 'closed' ? 0 : 1);
  }
});

test('publication lost acknowledgement reuses one signature, confirms exact bytes and refuses to replay vanished confirmation', async t => {
  const f = fixture(t);
  f.transport.broadcast = async () => { f.calls.broadcast++; throw new Error('SYNTHETIC_LOST_ACK'); };
  assert.equal((await advancePublication(f.journal, f.entry.id, f.transport)).state, 'absent');
  const stored = f.journal.snapshot()[0]; assert.ok(stored.transaction);
  assert.equal((await advancePublication(f.journal, f.entry.id, f.transport)).state, 'absent');
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 2);
  f.observe({ state: 'confirmed', confirmation: { transactionHash: stored.transaction!.hash, blockNumber: 20,
    blockHash: ethers.id('block'), status: 1, confirmations: 2, observedAt: 200 } });
  assert.equal((await advancePublication(f.journal, f.entry.id, f.transport)).state, 'confirmed');
  const bytes = fs.readFileSync(f.path);
  await advancePublication(f.journal, f.entry.id, f.transport); assert.deepEqual(fs.readFileSync(f.path), bytes);
  f.observe({ state: 'absent' });
  await assert.rejects(advancePublication(f.journal, f.entry.id, f.transport), /PUBLICATION_CONFIRMATION_CHANGED/);
  assert.equal(f.calls.broadcast, 2); assert.equal(f.calls.prepare, 1);
});

test('final publication observation accepts a later depth/time without signing, sending or persisting', async t => {
  const f = fixture(t);
  const entry = f.journal.prepare(f.entry.id, await f.transport.prepare(f.entry));
  const expected = { transactionHash: entry.transaction!.hash, blockNumber: 20, blockHash: ethers.id('block'),
    status: 1 as const, confirmations: 2, observedAt: 200 };
  const current = { ...expected, confirmations: 4, observedAt: 300 };
  f.observe({ state: 'confirmed', confirmation: current });
  const bytes = fs.readFileSync(f.path), calls = { ...f.calls };
  assert.deepEqual(await reobservePublication(f.transport, entry, expected), current);
  assert.deepEqual(fs.readFileSync(f.path), bytes); assert.deepEqual(f.calls, calls);
  assert.equal(f.journal.snapshot()[0].confirmation, undefined);
});

test('final publication observation fences missing, shallow, replaced, reverted or unbound source evidence', async t => {
  const f = fixture(t);
  const entry = f.journal.prepare(f.entry.id, await f.transport.prepare(f.entry));
  const expected = { transactionHash: entry.transaction!.hash, blockNumber: 20, blockHash: ethers.id('block'),
    status: 1 as const, confirmations: 2, observedAt: 200 };
  const bytes = fs.readFileSync(f.path), calls = { ...f.calls };
  const bad: PublicationObservation[] = [{ state: 'absent' }, { state: 'confirming' },
    ...[{ transactionHash: ethers.id('other-tx') }, { blockNumber: 21 }, { blockHash: ethers.id('fork') }, { status: 0 as const }]
      .map(change => ({ state: 'confirmed' as const, confirmation: { ...expected, ...change } }))];
  for (const observation of bad) {
    f.observe(observation);
    await assert.rejects(reobservePublication(f.transport, entry, expected), /PUBLICATION_CONFIRMATION_CHANGED/);
  }
  f.observe({ state: 'confirmed', confirmation: expected });
  for (const changed of [f.entry, { ...entry, abandonment: { at: 300, reason: 'UNSIGNED_PLAN_CANCELLED' as const } },
    { ...entry, transaction: { ...entry.transaction!, hash: ethers.id('wrong-bound-hash') } }])
    await assert.rejects(reobservePublication(f.transport, changed, expected), /PUBLICATION_CONFIRMATION_CHANGED/);
  await assert.rejects(reobservePublication(f.transport, entry, { ...expected, status: 0 }), /PUBLICATION_CONFIRMATION_CHANGED/);
  f.transport.observe = async () => { throw new Error('SYNTHETIC_RPC_UNAVAILABLE'); };
  await assert.rejects(reobservePublication(f.transport, entry, expected), /SYNTHETIC_RPC_UNAVAILABLE/);
  assert.deepEqual(fs.readFileSync(f.path), bytes); assert.deepEqual(f.calls, calls);
});
