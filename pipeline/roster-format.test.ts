import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { assertRosterRecordVersion, requireRosterV2 } from './roster-format.js';

test('only explicitly versioned v2 records are accepted', () => {
  for (const record of [{}, { rosterFormatVersion: 1 }, { rosterFormatVersion: 3 }]) {
    assert.throws(() => assertRosterRecordVersion(record), /Legacy or unknown/);
  }
  assert.throws(() => assertRosterRecordVersion({ rosterFormatVersion: 2 }), /Legacy or unknown/);
  assert.throws(() => assertRosterRecordVersion({ rosterFormatVersion: 2, epochSchemaVersion: 2 }));
  assert.doesNotThrow(() => assertRosterRecordVersion({ rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1 }));
});

test('compatibility guard rejects v1, unknown and failed reads before publication', async () => {
  const registry = '0x0000000000000000000000000000000000000001';
  for (const version of [1, 3, null]) {
    const provider = { call: async () => {
      if (version === null) throw new Error('unavailable');
      return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [version]);
    } } as unknown as ethers.Provider;
    await assert.rejects(requireRosterV2(provider, registry), /Refusing to publish or verify/);
  }
  const provider = { call: async ({ data }: { data: string }) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'],
    [data === ethers.id('ROSTER_AUTH_VERSION()').slice(0, 10) ? 1 : 2]) } as unknown as ethers.Provider;
  await assert.doesNotReject(requireRosterV2(provider, registry));
  const mixed = { call: async ({ data }: { data: string }) => ethers.AbiCoder.defaultAbiCoder().encode(['uint256'],
    [data === ethers.id('ROSTER_FORMAT_VERSION()').slice(0, 10) ? 2 : 1]) } as unknown as ethers.Provider;
  await assert.rejects(requireRosterV2(mixed, registry), /unsupported epoch schema/);
});
