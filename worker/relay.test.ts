import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import { Store, StoreWriteError, SourceSafetyError, type RelayEnvelope } from './store.js';
import { RelaySender, type RelayTransport, validateRelay } from './relay.js';
import { acquireWorkerLease } from './lease.js';
import { WorkerStoppedError } from './retry.js';

test('unsigned skip requires depth-bound positive state before and after source guard and persists its observation', async () => {
  for (const mode of ['pending', 'changed', 'hash', 'stop', 'hold', 'stable'] as const) {
    const f = fixture(), ctl = new AbortController(); let observations = 0, guards = 0;
    try {
      f.transport.observeProcessed = async (_id, expected) => {
        observations++;
        if (expected) assert.equal(expected.blockHash, ethers.id('query-block'));
        if (expected && mode === 'stop') ctl.abort();
        if (expected && mode === 'hold') { try { f.store.holdSource('SOURCE_SAFETY_HOLD'); } catch {} }
        return { status: mode === 'pending' || (expected && mode === 'changed') ? 'pending' : 'confirmed', blockNumber: 100,
          blockHash: expected && mode === 'hash' ? ethers.id('replacement') : ethers.id('query-block'), confirmations: 2, observedAt: 1000 };
      };
      const sender = new RelaySender(f.store, f.transport, async () => { guards++; }, ctl.signal);
      if (mode === 'stop') await assert.rejects(sender.step('a', f.prepare), WorkerStoppedError);
      else if (mode === 'hold') await assert.rejects(sender.step('a', f.prepare), /SOURCE_SAFETY/);
      else await sender.step('a', f.prepare);
      const saved = new Store(f.path).get('a')!;
      assert.equal(saved.state, mode === 'stable' ? 'skipped' : 'attested');
      assert.equal(saved.attempts, 0); assert.equal(f.calls.prepare, 0); assert.equal(f.calls.broadcast.length, 0);
      assert.equal(observations, mode === 'pending' ? 1 : 2); assert.equal(guards, mode === 'pending' ? 0 : 1);
      if (mode === 'stable') assert.deepEqual(saved.skipObservation, { blockNumber: 100, blockHash: ethers.id('query-block'), confirmations: 2, observedAt: 1000 });
      else assert.equal(saved.skipObservation, undefined);
    } finally { f.cleanup(); }
  }
});

test('final receipt changes after source/query checks cannot release the relay nonce', async () => {
  for (const reverted of [false, true]) {
    const f = fixture();
    try {
      await f.sender.step('a', f.prepare); f.mine(reverted);
      // The hub changes while the sender awaits its independent source guard.
      // Preserve the successful query answer to model an already-completed/stale RPC read.
      f.transport.processed = async () => true;
      const sender = new RelaySender(f.store, f.transport, async () => { f.unmine(); });
      await sender.step('a');
      const reopened = new Store(f.path);
      assert.equal(reopened.get('a')?.state, 'submitted', 'receipt disappearing during finalization must not become done/dead');
      assert.equal(reopened.relay?.raw, 'raw-1'); assert.equal(reopened.get('a')?.relayHistory, undefined);
      await assert.rejects(new RelaySender(reopened, f.transport).step('b', { ...f.prepare, queryId: 'query-b' }), /NONCE_UNRESOLVED/);
    } finally { f.cleanup(); }
  }
});

test('final receipt identity, shutdown and source hold are fenced before synchronous terminal persistence', async () => {
  for (const mode of ['height', 'hash', 'status', 'stop', 'hold'] as const) {
    const f = fixture(), ctl = new AbortController();
    try {
      await f.sender.step('a', f.prepare); f.mine();
      const receipt = f.transport.receipt; let reads = 0;
      f.transport.receipt = async relay => {
        const observed = await receipt(relay); if (++reads !== 2 || observed.status === 'pending') return observed;
        if (mode === 'stop') ctl.abort();
        if (mode === 'hold') { try { f.store.holdSource('SOURCE_REORG_TOUCHES_RELAYED_JOB'); } catch { /* persistent fence installed */ } }
        return { ...observed, ...(mode === 'height' ? { blockNumber: 101 } : {}), ...(mode === 'hash' ? { blockHash: 'different' } : {}),
          ...(mode === 'status' ? { status: 'reverted' as const } : {}) };
      };
      const sender = new RelaySender(f.store, f.transport, async () => {}, ctl.signal);
      if (mode === 'stop') await assert.rejects(sender.step('a'), WorkerStoppedError);
      else if (mode === 'hold') await assert.rejects(sender.step('a'), /SOURCE_REORG/);
      else await sender.step('a');
      const reopened = new Store(f.path); assert.equal(reopened.get('a')?.state, 'submitted');
      assert.equal(reopened.relay?.raw, 'raw-1'); assert.equal(reopened.get('a')?.relayHistory, undefined);
    } finally { f.cleanup(); }
  }
});

test('shutdown around persisted relay delivery retains the original envelope and resumes without another signature', async () => {
  for (const stopAfterBroadcast of [false, true]) {
    const f = fixture(); let stopped = false, reads = 0;
    try {
      const receipt = f.transport.receipt;
      f.transport.receipt = async relay => {
        reads++;
        if (reads === (stopAfterBroadcast ? 2 : 1)) { stopped = true; if (stopAfterBroadcast) f.mine(); }
        return receipt(relay);
      };
      const sender = new RelaySender(f.store, f.transport, async () => { if (stopped) throw new WorkerStoppedError(); });
      await assert.rejects(sender.step('a', f.prepare), WorkerStoppedError);
      const reopened = new Store(f.path);
      assert.equal(reopened.relay?.raw, 'raw-1'); assert.equal(reopened.get('a')?.state, 'submitted');
      assert.equal(reopened.get('a')?.attempts, 0); assert.equal(reopened.get('a')?.relayHistory, undefined);
      assert.equal(f.calls.broadcast.length, stopAfterBroadcast ? 1 : 0);
      await assert.rejects(new RelaySender(reopened, f.transport).step('b', { ...f.prepare, queryId: 'query-b' }), /NONCE_UNRESOLVED/);
      stopped = false; f.transport.receipt = receipt;
      const restarted = new RelaySender(reopened, f.transport); await restarted.step('a');
      if (!stopAfterBroadcast) { f.mine(); await restarted.step('a'); }
      assert.equal(reopened.get('a')?.state, 'done'); assert.equal(reopened.relay, undefined);
      assert.equal(f.calls.prepare, 1); assert.deepEqual(f.calls.broadcast, ['raw-1']);
    } finally { f.cleanup(); }
  }
});

function fixture(StoreType = Store) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-relay-')); const path = join(dir, 'worker.json');
  const store = new StoreType(path);
  for (const id of ['a', 'b']) store.add({ txHash: id, blockNumber: 1, action: 0, eventName: 'MarkIssued', logCount: 1, state: 'attested', attempts: 0 });
  let mined = false; let reverted = false; let processed = false; let loseResponse = false;
  const calls = { prepare: 0, broadcast: [] as string[] }; let nonce = 0;
  const transport: RelayTransport = {
    processed: async () => processed,
    observeProcessed: async queryId => ({ status: await transport.processed(queryId) ? 'confirmed' : 'unprocessed',
      blockNumber: 100, blockHash: ethers.id('confirmed-query'), confirmations: 2, observedAt: Date.now() }),
    prepare: async (sourceTxHash, queryId, data) => ({ sourceTxHash, queryId, data, raw: `raw-${++calls.prepare}`, hash: `hash-${calls.prepare}`, nonce: nonce++, chainId: 102031, to: 'asc', signer: 'relay' }),
    receipt: async () => mined ? { status: reverted ? 'reverted' : 'success', blockNumber: 100, blockHash: 'canonical' } : { status: 'pending' },
    broadcast: async tx => { calls.broadcast.push(tx.raw); if (loseResponse) throw new Error('response lost'); },
  };
  const prepare = { queryId: 'query-a', data: 'original-proof', gasLimit: 500000n };
  return { dir, path, store, transport, calls, prepare, sender: new RelaySender(store, transport),
    mine: (revert = false) => { mined = true; reverted = revert; processed = !revert; },
    lost: () => { loseResponse = true; }, unmine: () => { mined = false; processed = false; },
    cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('concurrent preparation has one signer owner; unknown receipt blocks the next job across restart', async () => {
  const f = fixture();
  try {
    const first = f.sender.step('a', f.prepare);
    await assert.rejects(f.sender.step('b', { ...f.prepare, queryId: 'query-b' }), /NONCE_UNRESOLVED/);
    await first; assert.equal(f.calls.prepare, 1); assert.equal(f.store.get('a')?.state, 'submitted');
    const reopened = new Store(f.path); const sender = new RelaySender(reopened, f.transport);
    await assert.rejects(sender.step('b', { ...f.prepare, queryId: 'query-b' }), /NONCE_UNRESOLVED/);
    await sender.step('a'); assert.deepEqual(f.calls.broadcast, ['raw-1', 'raw-1']); assert.equal(f.calls.prepare, 1);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(reopened.pending()[0].txHash, 'a');
    f.mine(); await sender.step('a'); assert.equal(reopened.relay, undefined); assert.equal(reopened.get('a')?.state, 'done');
    f.unmine(); await sender.step('b', { ...f.prepare, queryId: 'query-b' });
    assert.equal(new Store(f.path).relay?.nonce, 1); assert.equal(f.calls.prepare, 2);
  } finally { f.cleanup(); }
});

test('failure saving signature never broadcasts, including a committed save whose response was lost', async () => {
  for (const committed of [false, true]) {
    class FailingStore extends Store {
      override reserveRelay(tx: RelayEnvelope): void { if (committed) super.reserveRelay(tx); throw new StoreWriteError(); }
    }
    const f = fixture(FailingStore);
    try {
      await assert.rejects(f.sender.step('a', f.prepare), /STATE_WRITE_FAILED/);
      assert.equal(f.calls.broadcast.length, 0);
      const reopened = new Store(f.path);
      assert.equal(!!reopened.relay, committed);
      await new RelaySender(reopened, f.transport).step('a', f.prepare);
      assert.equal(f.calls.prepare, committed ? 1 : 2);
      if (committed) assert.deepEqual(f.calls.broadcast, ['raw-1']);
    } finally { f.cleanup(); }
  }
});

test('lost broadcast and receipt-save responses recover original transaction without another signature', async () => {
  class FailingFinish extends Store {
    override finishRelay(hash: string, receipt: Parameters<Store['finishRelay']>[1]): void {
      super.finishRelay(hash, receipt); throw new StoreWriteError();
    }
  }
  const f = fixture(FailingFinish);
  try {
    f.lost(); await f.sender.step('a', f.prepare);
    assert.equal(f.store.get('a')?.lastError, 'ASC_BROADCAST_UNCONFIRMED');
    f.mine(); await assert.rejects(f.sender.step('a'), /STATE_WRITE_FAILED/);
    const reopened = new Store(f.path);
    assert.equal(reopened.get('a')?.state, 'done'); assert.equal(reopened.relay, undefined);
    assert.equal(reopened.get('a')?.relayHistory?.[0].hash, 'hash-1'); assert.equal(f.calls.prepare, 1);
  } finally { f.cleanup(); }
});

test('confirmed revert releases the consumed nonce but dead-letters the original job for review', async () => {
  const f = fixture();
  try {
    await f.sender.step('a', f.prepare); f.mine(true); await f.sender.step('a');
    assert.equal(f.store.relay, undefined); assert.equal(f.store.get('a')?.state, 'dead');
    assert.equal(f.store.get('a')?.relayHistory?.[0].status, 'reverted');
    assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 1);
    await assert.rejects(f.sender.step('a', f.prepare), /JOB_NOT_PENDING/);
    assert.equal(f.calls.prepare, 1);
  } finally { f.cleanup(); }
});

test('already-processed query skips without signing; detached snapshots cannot mutate disk-backed state', async () => {
  const f = fixture();
  try {
    f.transport.processed = async () => true; await f.sender.step('a', f.prepare);
    assert.equal(f.calls.prepare, 0); assert.equal(f.store.get('a')?.state, 'skipped');
    const job = f.store.get('b')!; job.state = 'done'; f.store.pending()[0].state = 'dead';
    assert.equal(f.store.get('b')?.state, 'attested');
    assert.equal(JSON.parse(readFileSync(f.path, 'utf8')).jobs.b.state, 'attested');
  } finally { f.cleanup(); }
});

test('state target binding and exclusive process lease reject accidental reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-relay-scope-')); const path = join(dir, 'worker.json');
  const lease = `${path}.lock`; let release: (() => void) | undefined;
  const scope = { sourceChainId: 11155111, hubChainId: 102031, chainKey: 1, source: 'source', asc: 'asc', signer: 'signer', startBlock: 100 };
  try {
    release = acquireWorkerLease(lease); assert.throws(() => acquireWorkerLease(lease), /LEASE_UNAVAILABLE/);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import {openSync} from "node:fs"; try { openSync(process.argv[1], "wx"); process.exit(2); } catch(e) { process.exit(e.code === "EEXIST" ? 0 : 3); }', lease]);
    assert.equal(child.status, 0, 'separate process cannot acquire an owned lease');
    const store = new Store(path); store.bindScope(scope);
    new Store(path).bindScope(scope);
    for (const changed of [{ signer: 'other' }, { asc: 'other' }, { startBlock: 101 }, { sourceChainId: 1 }]) assert.throws(() => store.bindScope({ ...scope, ...changed }), /SCOPE_MISMATCH/);
    release(); release = acquireWorkerLease(lease);
    const legacy = new Store(join(dir, 'legacy.json')); legacy.setCursor(100);
    assert.throws(() => legacy.bindScope(scope), /LEGACY_WORKER_STATE/);
  } finally { release?.(); rmSync(dir, { recursive: true, force: true }); }
});

test('signed relay bytes bind nonce, chain, sender, destination and exact calldata', async () => {
  const wallet = ethers.Wallet.createRandom(); const asc = ethers.Wallet.createRandom().address;
  const raw = await wallet.signTransaction({ chainId: 102031, to: asc, nonce: 7, gasLimit: 30000, gasPrice: 1n, data: '0x1234', value: 0n });
  const relay: RelayEnvelope = { sourceTxHash: 'source', queryId: 'query', raw, hash: ethers.keccak256(raw), nonce: 7, chainId: 102031, to: asc, signer: wallet.address, data: '0x1234' };
  validateRelay(relay, 102031n, asc, wallet.address);
  for (const changed of [{ hash: ethers.ZeroHash }, { nonce: 8 }, { data: '0x5678' }, { signer: asc }, { to: wallet.address }, { chainId: 1 }]) {
    assert.throws(() => validateRelay({ ...relay, ...changed }, 102031n, asc, wallet.address), /MISMATCH/);
  }
});

test('source changes after signing or before broadcasting cannot leak the new signed bytes', async () => {
  for (const failAt of [2, 3]) {
    const f = fixture(); let guards = 0;
    try {
      const sender = new RelaySender(f.store, f.transport, async () => {
        if (++guards === failAt) {
          if (failAt === 3) f.store.holdSource('SOURCE_REORG_TOUCHES_RELAYED_JOB');
          throw new SourceSafetyError('SOURCE_JOB_NOT_CANONICAL_FINALIZED');
        }
      });
      await assert.rejects(sender.step('a', f.prepare), /SOURCE_/);
      assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast.length, 0);
      assert.equal(!!new Store(f.path).relay, failAt === 3);
      if (failAt === 3) assert.throws(() => new Store(f.path).assertSourceReady(), /SOURCE_REORG/);
    } finally { f.cleanup(); }
  }
});
