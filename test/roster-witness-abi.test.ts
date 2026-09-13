import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ROSTER_WITNESS_ABI } from '../pipeline/roster-witness.js';

test('roster witness consumer SDK matches compiled Registry functions and events', () => {
  const built = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ProofmarkRegistry.sol/ProofmarkRegistry.json', import.meta.url), 'utf8')).abi);
  for (const f of new ethers.Interface(ROSTER_WITNESS_ABI).fragments) {
    const expected = f.type === 'event' ? built.getEvent((f as ethers.EventFragment).name) : built.getFunction((f as ethers.FunctionFragment).name);
    assert.equal(expected!.format('full'), f.format('full'));
  }
});
