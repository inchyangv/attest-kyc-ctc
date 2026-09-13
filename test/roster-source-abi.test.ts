import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { ROSTER_LIFECYCLE_ABI } from '../pipeline/roster-source.js';

test('source snapshot lifecycle event schemas match compiled source exactly', () => {
  const built = new ethers.Interface(JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8')).abi);
  for (const f of new ethers.Interface(ROSTER_LIFECYCLE_ABI).fragments) assert.equal(built.getEvent((f as ethers.EventFragment).name)!.format('full'), f.format('full'));
});
