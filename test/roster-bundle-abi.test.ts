import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { BUNDLE_CHECK_ABIS } from '../pipeline/roster-bundle-chain.js';

test('bundle verifier call and return types agree with compiled ASC and Registry ABIs', () => {
  for (const [kind, name] of [['asc', 'ProofmarkASC'], ['registry', 'ProofmarkRegistry']] as const) {
    const built = new ethers.Interface(JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi);
    for (const f of new ethers.Interface(BUNDLE_CHECK_ABIS[kind]).fragments) {
      const expected = f.type === 'event' ? built.getEvent((f as ethers.EventFragment).name) : built.getFunction((f as ethers.FunctionFragment).name);
      assert.equal(expected!.format('sighash'), f.format('sighash'));
      if (f.type === 'function') assert.deepEqual((expected as ethers.FunctionFragment).outputs.map(p => p.format('sighash')), (f as ethers.FunctionFragment).outputs.map(p => p.format('sighash')));
    }
  }
});
