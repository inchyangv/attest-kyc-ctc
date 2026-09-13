import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { PROOFMARK_ASC_ABI } from '../worker/abi.js';
import { observeEpochCarry, requireCurrentPublishedEpoch, type ExpectedEpochCarry } from './epoch-carry.js';

function fixture() {
  const abi = new ethers.Interface(PROOFMARK_ASC_ABI), hash = ethers.id('hub-tx'), blockHash = ethers.id('hub-block');
  const expected: ExpectedEpochCarry = { asc: '0x' + '12'.repeat(20), epoch: 1, root: ethers.id('root'), validUntil: 1000,
    sourceCutoff: 100, publishedAt: 110, listVersion: 7, snapshotId: ethers.id('snapshot'), sourceBlock: 50, sourceTxIndex: 0 };
  const log = (name: string, args: unknown[], index: number) => ({ ...abi.encodeEventLog(abi.getEvent(name)!, args),
    address: expected.asc, transactionHash: hash, blockNumber: 20, blockHash, index, removed: false } as unknown as ethers.Log);
  const accepted = log('EpochAccepted', [1, expected.root, 1000], 0);
  const provenance = log('EpochProvenance', [1, 100, 110, 7, expected.snapshotId], 1);
  const state = { logs: [accepted], receipt: { hash, to: expected.asc, status: 1, blockNumber: 20, blockHash, logs: [accepted, provenance] },
    tx: { hash, to: expected.asc, chainId: 102031n, value: 0n, data: abi.encodeFunctionData('execute', [3, 1, 50, '0x', ethers.ZeroHash, [], ethers.ZeroHash, []]) },
    head: 22, finalHead: 22, finalHash: blockHash, query: true };
  const tags: unknown[] = []; let heads = 0, blocks = 0;
  const provider = { getNetwork: async () => ({ chainId: 102031n }), getBlockNumber: async () => ++heads === 1 ? state.head : state.finalHead,
    getLogs: async () => state.logs, getTransactionReceipt: async () => state.receipt, getTransaction: async () => state.tx,
    getBlock: async () => ({ number: 20, hash: ++blocks === 1 ? blockHash : state.finalHash, timestamp: 120 }),
    call: async (tx: { blockTag: unknown }) => { tags.push(tx.blockTag); return abi.encodeFunctionResult('processedQueries', [state.query]); },
  } as unknown as ethers.Provider;
  return { expected, state, provider, tags, abi };
}

test('carry binds exact receipt events, source execute coordinates and processed query at the acceptance block', async () => {
  const f = fixture(), result = await observeEpochCarry(f.provider, f.expected, 10, 3);
  assert.ok(result); assert.equal(result.transactionHash, f.state.tx.hash); assert.equal(result.timestamp, 120);
  assert.equal(result.confirmations, 3); assert.equal(result.sourceBlock, 50); assert.deepEqual(f.tags, [20]);
  requireCurrentPublishedEpoch(1, 1); assert.throws(() => requireCurrentPublishedEpoch(1, 2), /EPOCH_HUB_NO_LONGER_CURRENT/);
});

test('missing or shallow acceptance never invents a poll timestamp; final depth/hash regressions remain unconfirmed', async () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.state.logs = []; },
    (f: ReturnType<typeof fixture>) => { f.state.head = 20; },
    (f: ReturnType<typeof fixture>) => { f.state.finalHead = 20; },
    (f: ReturnType<typeof fixture>) => { f.state.finalHash = ethers.id('fork'); }]) {
    const f = fixture(); mutate(f); assert.equal(await observeEpochCarry(f.provider, f.expected, 10, 3), null);
  }
});

test('carry refuses wrong/duplicate events, missing provenance, reverted receipt, source coordinates, query and scan bounds', async () => {
  for (const [mutate, code] of [
    [(f: ReturnType<typeof fixture>) => { f.state.logs.push(f.state.logs[0]); }, 'EVENT'],
    [(f: ReturnType<typeof fixture>) => { f.state.logs[0] = { ...f.state.logs[0], data: '0x' } as ethers.Log; }, 'EVENT'],
    [(f: ReturnType<typeof fixture>) => { f.state.receipt.logs.pop(); }, 'EVENT'],
    [(f: ReturnType<typeof fixture>) => { f.state.receipt.status = 0; }, 'RECEIPT'],
    [(f: ReturnType<typeof fixture>) => { f.state.tx.data = f.abi.encodeFunctionData('execute', [3, 1, 51, '0x', ethers.ZeroHash, [], ethers.ZeroHash, []]); }, 'SOURCE_COORDINATES'],
    [(f: ReturnType<typeof fixture>) => { f.state.query = false; }, 'QUERY'],
  ] as const) {
    const f = fixture(); mutate(f); await assert.rejects(observeEpochCarry(f.provider, f.expected, 10, 3), new RegExp(`EPOCH_CARRY_${code}`));
  }
  const f = fixture(); await assert.rejects(observeEpochCarry(f.provider, f.expected, 10, 0), /CONFIG/);
  await assert.rejects(observeEpochCarry(f.provider, f.expected, 0, 1, 2), /SCAN/);
});
