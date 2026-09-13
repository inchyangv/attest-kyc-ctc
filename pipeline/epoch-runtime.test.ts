import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { checkEpochRuntimes, epochRuntimePins } from './epoch-runtime.js';

function fixture() {
  const addresses = { source: '0x' + '12'.repeat(20), asc: '0x' + '34'.repeat(20), registry: '0x' + '56'.repeat(20) };
  const code = { source: '0x6000', asc: '0x6001', registry: '0x6002' };
  const pins = { source: ethers.keccak256(code.source), asc: ethers.keccak256(code.asc), registry: ethers.keccak256(code.registry) };
  const env = { DEMO_SOURCE_CODEHASH: pins.source, DEMO_ASC_CODEHASH: pins.asc, DEMO_REGISTRY_CODEHASH: pins.registry };
  const reads: { address: string; block: unknown }[] = [];
  let changed = false, wrongChain = false;
  const provider = (source: boolean) => ({
    getNetwork: async () => ({ chainId: wrongChain ? 1n : source ? 11155111n : 102031n }),
    getBlock: async (tag: unknown) => ({ number: source ? 10 : 20, hash: ethers.id(changed && typeof tag === 'number' ? 'fork' : source ? 'source' : 'hub') }),
    getCode: async (address: string, block: unknown) => {
      reads.push({ address, block }); const key = (Object.keys(addresses) as (keyof typeof addresses)[]).find(k => addresses[k] === address)!;
      return code[key];
    },
  } as unknown as ethers.Provider);
  return { addresses, code, pins, env, reads, src: provider(true), hub: provider(false), reorg: () => { changed = true; }, wrongChain: () => { wrongChain = true; } };
}

test('runtime pins require all independently supplied full nonzero hashes before RPC', async () => {
  const f = fixture(); assert.deepEqual(epochRuntimePins(f.env), f.pins);
  for (const name of Object.keys(f.env)) for (const value of [undefined, '', '0x1234', ethers.ZeroHash]) {
    assert.throws(() => epochRuntimePins({ ...f.env, [name]: value }), /EPOCH_RUNTIME_PINS_REQUIRED/);
  }
  await assert.rejects(checkEpochRuntimes(f.src, f.hub, f.addresses, { ...f.pins, asc: ethers.ZeroHash }), /EPOCH_RUNTIME_PINS_REQUIRED/);
  assert.equal(f.reads.length, 0);
});

test('each runtime is hashed as exact nonempty bytes at explicit source/hub blocks', async () => {
  const f = fixture(); const observation = await checkEpochRuntimes(f.src, f.hub, f.addresses, f.pins, 20);
  assert.deepEqual(f.reads.map(r => r.block), [10, 20, 20]);
  assert.equal(observation.source.codeHash, f.pins.source); assert.equal(observation.asc.blockHash, ethers.id('hub'));
  for (const key of ['source', 'asc', 'registry'] as const) for (const code of ['0x', '0x0', 'garbage', '0x600300']) {
    const bad = fixture(); bad.code[key] = code;
    await assert.rejects(checkEpochRuntimes(bad.src, bad.hub, bad.addresses, bad.pins, 20), /EPOCH_RUNTIME_MISMATCH/);
  }
});

test('runtime observations reject wrong network, selected height mismatch and replaced source block', async () => {
  const f = fixture(); f.wrongChain();
  await assert.rejects(checkEpochRuntimes(f.src, f.hub, f.addresses, f.pins), /EPOCH_RUNTIME_CHAIN_MISMATCH/);
  const g = fixture();
  await assert.rejects(checkEpochRuntimes(g.src, g.hub, g.addresses, g.pins, 21), /EPOCH_RUNTIME_BLOCK_UNAVAILABLE/);
  g.reorg();
  await assert.rejects(checkEpochRuntimes(g.src, g.hub, g.addresses, g.pins), /EPOCH_RUNTIME_OBSERVATION_CHANGED/);
});
