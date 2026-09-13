import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { POLICY_REGISTRY_ABI } from '../pipeline/policy.js';
test('typed policy SDK ABI matches compiled Registry input and output layouts', () => {
  const built = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ProofmarkRegistry.sol/ProofmarkRegistry.json', import.meta.url), 'utf8')).abi);
  const shared = new ethers.Interface(POLICY_REGISTRY_ABI);
  for (const fragment of shared.fragments) {
    const f = fragment as ethers.FunctionFragment;
    assert.deepEqual(JSON.parse(built.getFunction(f.name)!.format('json')), JSON.parse(f.format('json')));
  }
});
