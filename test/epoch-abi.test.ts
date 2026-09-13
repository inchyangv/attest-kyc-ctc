import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { EPOCH_SOURCE_ABI } from '../pipeline/epoch.js';

test('epoch v2 SDK function and receipt event layouts match the compiled source', () => {
  const built = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8')).abi);
  for (const f of new ethers.Interface(EPOCH_SOURCE_ABI).fragments) {
    const expected = f.type === 'event' ? built.getEvent((f as ethers.EventFragment).name) : built.getFunction((f as ethers.FunctionFragment).name);
    // Human-readable fragments omit indexed:false in JSON; full format normalizes that absence.
    assert.equal(expected!.format('full'), f.format('full'));
  }
});
