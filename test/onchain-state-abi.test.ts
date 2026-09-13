import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { STATUS_ASC_ABI, STATUS_REGISTRY_ABI } from '../pipeline/onchain-state.js';

test('status reader wire layouts match both compiled contracts, including nested witness and mark tuples', () => {
  for (const [name, fragments] of [['ProofmarkASC', STATUS_ASC_ABI], ['ProofmarkRegistry', STATUS_REGISTRY_ABI]] as const) {
    const artifact = JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
    const built = new ethers.Interface(artifact.abi);
    for (const f of new ethers.Interface(fragments).fragments) {
      if (f.type !== 'function') continue;
      const fn = f as ethers.FunctionFragment; const expected = built.getFunction(fn.name)!;
      assert.equal(fn.selector, expected.selector);
      assert.deepEqual(fn.outputs.map(o => o.format('sighash')), expected.outputs.map(o => o.format('sighash')), `${name}.${fn.name}`);
    }
  }
});
