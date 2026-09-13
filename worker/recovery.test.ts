import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { initializeHubRecovery, reconcileHubRecovery, type HubRecoveryReader } from './recovery.js';

const scope = { sourceChainId: 11155111, hubChainId: 102031, chainKey: 1,
  source: '0x1000000000000000000000000000000000000001', asc: '0x2000000000000000000000000000000000000002',
  signer: '0x3000000000000000000000000000000000000003', startBlock: 1 };

class FakeHub implements HubRecoveryReader {
  latest = 0; pending = 0; head = 20;
  blocks = new Map<number, string>();
  receipts = new Map<string, Awaited<ReturnType<HubRecoveryReader['receipt']>>>();
  queries = new Map<string, boolean>();
  transactionCount(_address: string, tag: 'latest' | 'pending') { return Promise.resolve(tag === 'latest' ? this.latest : this.pending); }
  blockNumber() { return Promise.resolve(this.head); }
  block(height: number) { const hash = this.blocks.get(height); return Promise.resolve(hash ? { number: height, hash } : null); }
  receipt(hash: string) { return Promise.resolve(this.receipts.get(hash) ?? null); }
  processed(queryId: string, blockNumber: number) { return Promise.resolve(this.queries.get(`${queryId}:${blockNumber}`) ?? false); }
  addReceipt(hash: string, nonce: number, queryId: string, status: 'success' | 'reverted' = 'success', blockNumber = 10) {
    const blockHash = `0x${(blockNumber + 100).toString(16).padStart(64, '0')}`;
    this.blocks.set(blockNumber, blockHash);
    this.receipts.set(hash, { hash, from: scope.signer, to: scope.asc, status: status === 'success' ? 1 : 0, blockNumber, blockHash });
    this.queries.set(`${queryId}:${blockNumber}`, status === 'success');
    this.latest = nonce + 1; this.pending = nonce + 1;
    return blockHash;
  }
}

const addJob = (store: Store, id: string) => {
  const txHash = `0x${id.padStart(64, '0')}`;
  store.add({ txHash, blockNumber: 2, blockHash: `0x${'12'.repeat(32)}`, transactionIndex: 0,
    action: 0, eventName: 'MarkIssued', logCount: 1, state: 'attested', attempts: 0 });
  return txHash;
};

const finish = (store: Store, hub: FakeHub, id: string, nonce: number, status: 'success' | 'reverted' = 'success') => {
  const txHash = addJob(store, id), queryId = `0x${(`a${id}`).padStart(64, '0')}`, relayHash = `0x${(`b${id}`).padStart(64, '0')}`;
  const blockHash = hub.addReceipt(relayHash, nonce, queryId, status);
  store.reserveRelay({ sourceTxHash: txHash, queryId, hash: relayHash, raw: 'signed', nonce, chainId: 102031,
    to: scope.asc, signer: scope.signer, data: '0x1234' });
  store.finishRelay(relayHash, { status, blockNumber: 10, blockHash });
  return { txHash, queryId, relayHash };
};

test('PM-T16-02 lost state cannot cold-start after its dedicated signer already consumed a nonce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-recovery-red-'));
  try {
    const store = new Store(join(dir, 'lost-state.json'));
    store.bindScope(scope);
    const hub = {
      transactionCount: async (_address: string, _tag: 'latest' | 'pending') => 1,
      blockNumber: async () => 1,
      block: async (_height: number) => null,
      receipt: async (_hash: string) => null,
      processed: async (_queryId: string, _blockNumber: number) => false,
    };
    await assert.rejects(reconcileHubRecovery(store, hub, 2), /HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stable terminal and confirmed-skip history remains restartable at exact hub blocks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-recovery-stable-'));
  try {
    const store = new Store(join(dir, 'state.json')), hub = new FakeHub(); store.bindScope(scope);
    await initializeHubRecovery(store, hub);
    finish(store, hub, '1', 0);
    const skipped = addJob(store, '2'), queryId = `0x${'c'.repeat(64)}`, blockNumber = 11;
    const blockHash = `0x${'d'.repeat(64)}`; hub.blocks.set(blockNumber, blockHash); hub.queries.set(`${queryId}:${blockNumber}`, true);
    store.update(skipped, { state: 'skipped', queryId, skipObservation: { blockNumber, blockHash, confirmations: 10, observedAt: Date.now() } });
    await reconcileHubRecovery(store, hub, 2);
    assert.doesNotThrow(() => store.assertHubReady()); assert.equal(store.recoverySnapshot().hubStartNonce, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale backup nonce drift and a disappeared released receipt install persistent hub holds', async () => {
  for (const mode of ['stale-backup', 'deep-reorg'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `proofmark-recovery-${mode}-`));
    try {
      const store = new Store(join(dir, 'state.json')), hub = new FakeHub(); store.bindScope(scope); store.initializeHubSigner(0);
      const terminal = finish(store, hub, '1', 0);
      if (mode === 'stale-backup') { hub.latest = 2; hub.pending = 2; }
      else hub.receipts.delete(terminal.relayHash);
      await assert.rejects(reconcileHubRecovery(store, hub, 2), mode === 'stale-backup' ? /HUB_SIGNER_NONCE_DIVERGED/ : /HUB_TERMINAL_HISTORY_NOT_CANONICAL/);
      assert.throws(() => new Store(join(dir, 'state.json')).assertHubReady(), /HUB_/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('an unresolved stored envelope permits only its exact next nonce while unknown pending use is held', async () => {
  for (const stored of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), 'proofmark-recovery-pending-'));
    try {
      const store = new Store(join(dir, 'state.json')), hub = new FakeHub(); store.bindScope(scope); store.initializeHubSigner(0);
      const txHash = addJob(store, stored ? '3' : '4'); hub.pending = 1;
      if (stored) store.reserveRelay({ sourceTxHash: txHash, queryId: `0x${'e'.repeat(64)}`, hash: `0x${'f'.repeat(64)}`,
        raw: 'signed', nonce: 0, chainId: 102031, to: scope.asc, signer: scope.signer, data: '0x1234' });
      if (stored) await reconcileHubRecovery(store, hub, 2);
      else await assert.rejects(reconcileHubRecovery(store, hub, 2), /HUB_SIGNER_NONCE_DIVERGED/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('a poll audit discards a mixed sample when the singleton sender reserves during RPC awaits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-recovery-race-'));
  try {
    const store = new Store(join(dir, 'state.json')), hub = new FakeHub(); store.bindScope(scope); store.initializeHubSigner(0);
    const txHash = addJob(store, '5'); let reserved = false;
    hub.transactionCount = async (_address: string, _tag: 'latest' | 'pending') => {
      if (!reserved) {
        reserved = true; store.reserveRelay({ sourceTxHash: txHash, queryId: `0x${'1'.repeat(64)}`, hash: `0x${'2'.repeat(64)}`,
          raw: 'signed', nonce: 0, chainId: 102031, to: scope.asc, signer: scope.signer, data: '0x1234' });
      }
      return 1;
    };
    await reconcileHubRecovery(store, hub, 2);
    assert.doesNotThrow(() => store.assertHubReady()); assert.equal(store.relay?.nonce, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
