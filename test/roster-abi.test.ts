import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ROSTER_REGISTRY_ABI, ROSTER_SELECTORS } from '../pipeline/roster-format.js';

test('shared proof ABI agrees with the compiled registry', () => {
  const artifact = JSON.parse(readFileSync(new URL('../out/ProofmarkRegistry.sol/ProofmarkRegistry.json', import.meta.url), 'utf8'));
  const compiled = new ethers.Interface(artifact.abi);
  const shared = new ethers.Interface(ROSTER_REGISTRY_ABI);
  for (const name of ['ROSTER_FORMAT_VERSION', 'verifyWithRoster', 'proveNotInRoster']) {
    assert.equal(shared.getFunction(name)!.format('sighash'), compiled.getFunction(name)!.format('sighash'));
  }
  assert.deepEqual(ROSTER_SELECTORS, ['verifyWithRoster', 'proveNotInRoster'].map(name => compiled.getFunction(name)!.selector.slice(2)));
});
