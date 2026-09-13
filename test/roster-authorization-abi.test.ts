import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ROSTER_AUTH_ABI } from '../pipeline/roster-authorization.js';

test('roster authorization SDK functions and receipt event match compiled source', () => {
  const built = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8')).abi);
  for (const f of new ethers.Interface(ROSTER_AUTH_ABI).fragments) {
    const expected = f.type === 'event' ? built.getEvent((f as ethers.EventFragment).name) : built.getFunction((f as ethers.FunctionFragment).name);
    assert.equal(expected!.format('full'), f.format('full'));
  }
});
