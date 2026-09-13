import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { captureEpochHub, assertEpochHub } from './epoch-observation.js';
import { requireRosterV2, ROSTER_REGISTRY_ABI } from './roster-format.js';

test('epoch observation captures explicit hub identity and rejects changed final block or network', async () => {
  const block = { number: 55, hash: ethers.id('canonical'), timestamp: 1800000000 };
  let returned = { ...block }, chainId = 102031n;
  const tags: unknown[] = [];
  const provider = { getNetwork: async () => ({ chainId }), getBlock: async (tag: unknown) => { tags.push(tag); return returned; } } as unknown as ethers.Provider;
  const observation = await captureEpochHub(provider);
  await assertEpochHub(provider, observation); assert.deepEqual(tags, ['latest', 55]);
  for (const patch of [{ hash: ethers.id('fork') }, { number: 56 }, { timestamp: block.timestamp + 1 }]) {
    returned = { ...block, ...patch }; await assert.rejects(assertEpochHub(provider, observation), /EPOCH_HUB_OBSERVATION_CHANGED/);
  }
  returned = block; chainId = 1n;
  await assert.rejects(assertEpochHub(provider, observation), /EPOCH_HUB_OBSERVATION_CHANGED/);
  await assert.rejects(captureEpochHub(provider), /EPOCH_HUB_CHAIN_MISMATCH/);
  chainId = 102031n; returned = { ...block, hash: '0x' };
  await assert.rejects(captureEpochHub(provider), /EPOCH_HUB_BLOCK_UNAVAILABLE/);
});

test('registry compatibility reads all schema versions at the supplied observation block', async () => {
  const abi = new ethers.Interface(ROSTER_REGISTRY_ABI), tags: unknown[] = [], names: string[] = [];
  const provider = { call: async (tx: { data: string; blockTag: unknown }) => {
    const name = abi.getFunction(tx.data.slice(0, 10))!.name; tags.push(tx.blockTag); names.push(name);
    return abi.encodeFunctionResult(name, [name === 'ROSTER_AUTH_VERSION' ? 1 : 2]);
  } } as unknown as ethers.Provider;
  await requireRosterV2(provider, ethers.getAddress('0x' + '12'.repeat(20)), 55);
  assert.deepEqual(names, ['ROSTER_FORMAT_VERSION', 'EPOCH_SCHEMA_VERSION', 'ROSTER_AUTH_VERSION']);
  assert.deepEqual(tags, [55, 55, 55]);
});
