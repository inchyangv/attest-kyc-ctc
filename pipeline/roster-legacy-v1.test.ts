import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import {
  buildLegacyRoster, detectRosterGeneration, isLegacyRosterRecord, legacyInclusionProof, legacyLeafIndexOf,
  legacyNonInclusionProof, legacySubjectKey, verifyLegacyInclusion, verifyLegacyNonInclusion, LEGACY_REGISTRY_ABI,
  type LegacyRosterEntry,
} from './roster-legacy-v1.js';
import { buildRoster } from './roster.js';

const record = JSON.parse(readFileSync(new URL('../deployments/epoch-1.json', import.meta.url), 'utf8')) as {
  root: string; entries: LegacyRosterEntry[]; rosterFormatVersion?: number;
};
const NEVER_ISSUED = '0x00000000000000000000000000000000DeaDBeef';

test('the checked-in epoch 1 record is a legacy record and its root is reproduced exactly', () => {
  assert.equal(isLegacyRosterRecord(record), true);
  const tree = buildLegacyRoster(record.entries);
  assert.equal(tree.root.toLowerCase(), record.root.toLowerCase());
  assert.equal(tree.leaves.length, record.entries.length + 2, 'both sentinels are present');
  // The v2 format deliberately hashes differently; it must not reproduce a v1 root.
  assert.notEqual(buildRoster(record.entries).root.toLowerCase(), record.root.toLowerCase());
});

test('legacy inclusion and non-inclusion proofs verify against the reproduced root', () => {
  const tree = buildLegacyRoster(record.entries);
  for (let i = 0; i < tree.entries.length; i++) {
    const proof = legacyInclusionProof(tree, legacyLeafIndexOf(i));
    assert.equal(verifyLegacyInclusion(tree.root, tree.leaves[legacyLeafIndexOf(i)], proof), true);
    assert.equal(verifyLegacyInclusion(tree.root, tree.leaves[0], proof), false, 'a different leaf does not verify with this path');
  }
  const absent = legacyNonInclusionProof(tree, NEVER_ISSUED);
  assert.equal(absent.right.index, absent.left.index + 1);
  assert.equal(verifyLegacyNonInclusion(tree.root, NEVER_ISSUED, absent), true);
  assert.throws(() => legacyNonInclusionProof(tree, record.entries[0].subject), /in the roster/);
  const shiftedKey = ethers.toBeHex(BigInt(absent.leftKey) + 1n, 32);
  assert.ok(shiftedKey < legacySubjectKey(NEVER_ISSUED), 'the shifted key still satisfies the ordering check');
  const relabelled = { ...absent, leftKey: shiftedKey };
  assert.equal(verifyLegacyNonInclusion(tree.root, NEVER_ISSUED, relabelled), false, 'a relabelled boundary key no longer hashes to its leaf');
});

test('v2 records are not mistaken for legacy records', () => {
  assert.equal(isLegacyRosterRecord({ rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1 }), false);
  assert.equal(isLegacyRosterRecord({ rosterFormatVersion: 2 }), false);
});

function fakeProvider(behaviour: 'v2' | 'revert' | 'empty' | 'network' | 'nocode' | 'unknown') {
  const iface = new ethers.Interface(LEGACY_REGISTRY_ABI);
  return {
    getCode: async () => (behaviour === 'nocode' ? '0x' : '0x6080'),
    call: async () => {
      if (behaviour === 'revert') throw Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
      if (behaviour === 'network') throw Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' });
      if (behaviour === 'empty') return '0x';
      return iface.encodeFunctionResult('ROSTER_FORMAT_VERSION', [behaviour === 'v2' ? 2n : 7n]);
    },
  } as unknown as ethers.Provider;
}

test('roster generation detection separates v2, the reverting v1 build, and real failures', async () => {
  const registry = '0x' + '22'.repeat(20);
  assert.equal(await detectRosterGeneration(fakeProvider('v2'), registry), 'v2');
  assert.equal(await detectRosterGeneration(fakeProvider('revert'), registry), 'v1-live');
  assert.equal(await detectRosterGeneration(fakeProvider('empty'), registry), 'v1-live');
  await assert.rejects(detectRosterGeneration(fakeProvider('network'), registry), /fetch failed/);
  await assert.rejects(detectRosterGeneration(fakeProvider('nocode'), registry), /no contract code/);
  await assert.rejects(detectRosterGeneration(fakeProvider('unknown'), registry), /unknown roster format 7/);
});
