import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { Store } from './store.js';
import { scanSourceStep, type SourceReader } from './source-scan.js';

const address = '0x' + '11'.repeat(20);
const iface = new ethers.Interface(['event MarkRevoked(address indexed subject,uint16 indexed reasonCode,uint32 indexed epoch)']);
const options = { address, startBlock: 4, confirmations: 2, chunk: 3 };
class Source implements SourceReader {
  head = 14; finalized: number | null = 9; fork = Infinity; logs: ethers.Log[] = [];
  afterLogs?: () => void;
  async getBlockNumber() { return this.head; }
  hash(height: number) { return ethers.id(`${height >= this.fork ? 'fork' : 'original'}-${height}`); }
  async getBlock(tag: number | 'finalized') {
    const number = tag === 'finalized' ? this.finalized : tag;
    return number === null ? null : { number, hash: this.hash(number) };
  }
  async getLogs({ fromBlock, toBlock }: { address: string; fromBlock: number; toBlock: number }) {
    const logs = this.logs.filter(l => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
    this.afterLogs?.(); return logs;
  }
  log(height: number, name = 'source-tx', transactionIndex = 0): ethers.Log {
    return { ...iface.encodeEventLog(iface.getEvent('MarkRevoked')!, [address, 2, 0]), address, blockNumber: height, blockHash: this.hash(height),
      index: 0, transactionIndex, transactionHash: ethers.id(name), removed: false } as unknown as ethers.Log;
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-source-scan-')); const path = join(dir, 'state.json');
  const store = new Store(path); const source = new Source();
  return { store, source, path, run: () => scanSourceStep(store, source, iface, options), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('cold start scans explicit finalized ranges and atomically persists jobs with hash/tx coordinates', async () => {
  const f = fixture();
  try {
    f.source.logs = [f.source.log(5)];
    assert.deepEqual(await f.run(), { scanned: true, jobs: 1, rewound: 0 });
    const reopened = new Store(f.path);
    assert.equal(reopened.cursor, 6); assert.equal(reopened.checkpoints.at(-1)?.hash, f.source.hash(6));
    assert.equal(reopened.get(ethers.id('source-tx'))?.blockHash, f.source.hash(5));
    assert.equal(reopened.get(ethers.id('source-tx'))?.transactionIndex, 0);
    await f.run(); assert.equal(f.store.cursor, 9);
    assert.equal((await f.run()).scanned, false); assert.equal(f.store.cursor, 9, 'head 14 is not the finalized head');
  } finally { f.cleanup(); }
});

test('unsigned reorg rewinds to a common checkpoint and relocates the same source transaction', async () => {
  const f = fixture();
  try {
    f.source.logs = [f.source.log(5, 'stable'), f.source.log(8, 'moves')]; await f.run(); await f.run();
    f.store.update(ethers.id('moves'), { state: 'attested' });
    f.source.fork = 7; f.source.logs = [f.source.log(5, 'stable'), f.source.log(9, 'moves', 2)];
    assert.deepEqual(await f.run(), { scanned: true, jobs: 1, rewound: 1 });
    const moved = new Store(f.path).get(ethers.id('moves'))!;
    assert.equal(moved.blockNumber, 9); assert.equal(moved.transactionIndex, 2); assert.equal(moved.state, 'discovered');
    assert.equal(moved.blockHash, f.source.hash(9)); assert.equal(f.store.get(ethers.id('stable'))?.blockNumber, 5);
    assert.deepEqual(JSON.parse(readFileSync(f.path, 'utf8')).sourceRewinds[0].orphanedTxs, [ethers.id('moves')]);
  } finally { f.cleanup(); }
});

test('fork touching signed relay state preserves envelope and sets a persistent hold', async () => {
  const f = fixture();
  try {
    f.source.logs = [f.source.log(8)]; await f.run(); await f.run();
    f.store.reserveRelay({ sourceTxHash: ethers.id('source-tx'), queryId: ethers.id('query'), hash: ethers.id('hub'), raw: 'original-signed-bytes', nonce: 1, chainId: 102031, to: address, signer: address, data: '0x1234' });
    f.source.fork = 7;
    await assert.rejects(f.run(), /REORG_TOUCHES_RELAYED_JOB/);
    const reopened = new Store(f.path); assert.equal(reopened.cursor, 9); assert.equal(reopened.relay?.raw, 'original-signed-bytes');
    assert.throws(() => reopened.assertSourceReady(), /REORG_TOUCHES_RELAYED_JOB/);
  } finally { f.cleanup(); }
});

test('already-processed job is not erased by a source fork, even without our own hub transaction', async () => {
  const f = fixture();
  try {
    f.source.logs = [f.source.log(8)]; await f.run(); await f.run();
    f.store.update(ethers.id('source-tx'), { state: 'skipped', queryId: ethers.id('query') }); f.source.fork = 7;
    await assert.rejects(f.run(), /REORG_TOUCHES_RELAYED_JOB/);
    assert.equal(f.store.get(ethers.id('source-tx'))?.state, 'skipped');
  } finally { f.cleanup(); }
});

test('fork detected while jobs execute requires drain/restart before changing stored jobs', async () => {
  const f = fixture();
  try {
    f.source.logs = [f.source.log(8)]; await f.run(); await f.run(); f.source.fork = 7;
    await assert.rejects(scanSourceStep(f.store, f.source, iface, { ...options, beforeRewind: () => { throw new Error('drain first'); } }), /drain first/);
    assert.equal(f.store.cursor, 9); assert.equal(f.store.get(ethers.id('source-tx'))?.blockNumber, 8);
  } finally { f.cleanup(); }
});

test('mid-read range reorg, bad log hash, or unavailable finality never commits a partial range', async () => {
  for (const mode of ['mid-read', 'bad-log', 'no-finality', 'bad-head', 'finality-above-head']) {
    const f = fixture();
    try {
      f.source.logs = [f.source.log(5)];
      if (mode === 'mid-read') f.source.afterLogs = () => { f.source.fork = 6; };
      if (mode === 'bad-log') f.source.logs[0] = { ...f.source.logs[0], blockHash: ethers.ZeroHash } as ethers.Log;
      if (mode === 'no-finality') f.source.finalized = null;
      if (mode === 'bad-head') f.source.afterLogs = () => { f.source.head = NaN; };
      if (mode === 'finality-above-head') f.source.afterLogs = () => { f.source.finalized = 20; };
      await assert.rejects(f.run(), /SOURCE_/);
      assert.equal(f.store.has(ethers.id('source-tx')), false); assert.ok(f.store.cursor <= 3);
    } finally { f.cleanup(); }
  }
});

test('missing checkpoint block is uncertainty, not evidence authorizing a rewind', async () => {
  const f = fixture();
  try {
    await f.run(); const read = f.source.getBlock.bind(f.source);
    f.source.getBlock = async tag => tag === 6 ? null : read(tag);
    await assert.rejects(f.run(), /CHECKPOINT_UNAVAILABLE/); assert.equal(f.store.cursor, 6);
    assert.doesNotThrow(() => f.store.assertSourceReady());
  } finally { f.cleanup(); }
});

test('fork before the retained anchor requires reconciliation; old unhashed state is not silently trusted', async () => {
  const f = fixture(); const g = fixture();
  try {
    await f.run(); f.source.fork = 0;
    await assert.rejects(f.run(), /BEYOND_VERIFIED_ANCHOR/);
    assert.throws(() => new Store(f.path).assertSourceReady(), /BEYOND_VERIFIED_ANCHOR/);
    g.store.setCursor(7);
    await assert.rejects(g.run(), /UNHASHED_SOURCE_STATE/);
  } finally { f.cleanup(); g.cleanup(); }
});
