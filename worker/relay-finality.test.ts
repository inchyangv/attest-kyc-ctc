import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { EvmRelayTransport } from './relay.js';

test('processed query sampling distinguishes absent, shallow, confirmed and not-yet-deployed confirmation floors', async () => {
  for (const mode of ['absent', 'shallow', 'confirmed', 'undeployed', 'short-chain'] as const) {
    const reads: number[] = [], wallet = new ethers.Wallet('0x' + '12'.repeat(32));
    const provider = { getBlockNumber: async () => mode === 'short-chain' ? 0 : 20,
      getBlock: async (height: number) => ({ number: height, hash: ethers.id(`block-${height}`) }),
      getCode: async () => mode === 'undeployed' ? '0x' : '0x6000' } as unknown as ethers.Provider;
    const asc = { getAddress: async () => wallet.address, processedQueries: async (_id: string, opts: { blockTag: number }) => {
      reads.push(opts.blockTag); return mode !== 'absent' && (mode !== 'shallow' || opts.blockTag === 20);
    } } as unknown as ethers.Contract;
    const result = await new EvmRelayTransport(provider, wallet, asc, 2).observeProcessed(ethers.id('q'));
    assert.equal(result.status, mode === 'absent' ? 'unprocessed' : mode === 'confirmed' ? 'confirmed' : 'pending');
    if (mode === 'confirmed' || mode === 'shallow') assert.deepEqual(reads, [20, 19]);
    else assert.equal(reads.length, 1);
    if (mode === 'confirmed') { assert.equal(result.blockNumber, 19); assert.equal(result.confirmations, 2); }
  }
});

test('processed observations reject forked/nonnumeric/nonboolean reads and revalidate the exact earlier block', async () => {
  const wallet = new ethers.Wallet('0x' + '12'.repeat(32));
  for (const mode of ['stable', 'fork', 'recheck-fork', 'lost-query', 'depth-drop', 'bad-head', 'bad-value'] as const) {
    let blocks = 0, rechecking = false;
    const provider = {
      getBlockNumber: async () => mode === 'bad-head' ? NaN : rechecking && mode === 'depth-drop' ? 19 : 20,
      getBlock: async (height: number) => ({ number: height, hash: (mode === 'fork' && ++blocks > 1) || (mode === 'recheck-fork' && rechecking)
        ? ethers.id('replacement') : ethers.id(`block-${height}`) }), getCode: async () => '0x6000',
    } as unknown as ethers.Provider;
    const asc = { getAddress: async () => wallet.address, processedQueries: async (_id: string, opts: { blockTag: number }) => {
      if (rechecking) assert.equal(opts.blockTag, 19);
      return mode === 'bad-value' ? 'true' : !(mode === 'lost-query' && rechecking);
    } } as unknown as ethers.Contract;
    const transport = new EvmRelayTransport(provider, wallet, asc, 2);
    if (['fork', 'bad-head', 'bad-value'].includes(mode)) { await assert.rejects(transport.observeProcessed(ethers.id('q')), /ASC_QUERY_OBSERVATION/); continue; }
    const initial = await transport.observeProcessed(ethers.id('q')); assert.equal(initial.status, 'confirmed'); rechecking = true;
    if (mode === 'recheck-fork') await assert.rejects(transport.observeProcessed(ethers.id('q'), initial), /OBSERVATION_CHANGED/);
    else assert.equal((await transport.observeProcessed(ethers.id('q'), initial)).status, mode === 'stable' ? 'confirmed' : 'pending');
  }
});

test('EVM receipt checks numeric coordinates and re-reads canonical block hash after the depth sample', async () => {
  const wallet = new ethers.Wallet('0x' + '12'.repeat(32)), to = '0x' + '34'.repeat(20), blockHash = ethers.id('original');
  const raw = await wallet.signTransaction({ chainId: 102031, to, nonce: 0, gasLimit: 30000, gasPrice: 1, data: '0x', value: 0 });
  const relay = { sourceTxHash: ethers.id('source'), queryId: ethers.id('query'), hash: ethers.keccak256(raw), raw,
    nonce: 0, chainId: 102031, to, signer: wallet.address, data: '0x' };
  for (const mode of ['stable', 'changed-hash', 'changed-height', 'bad-head', 'shallow', 'invalid-receipt'] as const) {
    let blocks = 0;
    const provider = {
      getTransactionReceipt: async () => ({ hash: relay.hash, from: wallet.address, to, status: 1,
        blockNumber: mode === 'invalid-receipt' ? 1.5 : 10, blockHash }),
      getBlockNumber: async () => mode === 'bad-head' ? NaN : mode === 'shallow' ? 10 : 20,
      getBlock: async () => { blocks++; return { number: blocks > 1 && mode === 'changed-height' ? 11 : 10,
        hash: blocks > 1 && mode === 'changed-hash' ? ethers.id('replacement') : blockHash }; },
    } as unknown as ethers.Provider;
    const transport = new EvmRelayTransport(provider, wallet, { getAddress: async () => to } as unknown as ethers.Contract, 2);
    if (mode === 'invalid-receipt') await assert.rejects(transport.receipt(relay), /RELAY_RECEIPT_MISMATCH/);
    else {
      const result = await transport.receipt(relay); assert.equal(result.status, mode === 'stable' ? 'success' : 'pending');
      if (['stable', 'changed-hash', 'changed-height'].includes(mode)) assert.equal(blocks, 2);
    }
  }
});
