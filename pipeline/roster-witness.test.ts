import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { buildRoster, rosterLeaf, verifyInclusion } from './roster.js';
import { encodeRosterWitness, requireRosterWitness, ROSTER_WITNESS_ABI } from './roster-witness.js';

const subject = '0x' + '11'.repeat(20);
const entry = { subject, attrs: ethers.id('synthetic-attrs'), claimsRoot: ethers.id('claims'), evidenceHash: ethers.id('evidence'), issuer: '0x' + '22'.repeat(20) };
const record = { rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1, root: buildRoster([entry]).root, entries: [entry] };

test('witness encoder binds the exact leaf, subject, root and size-bound proof without signing', () => {
  const call = encodeRosterWitness(record, subject);
  const decoded = new ethers.Interface(ROSTER_WITNESS_ABI).decodeFunctionData('cacheRosterWitness', call.data);
  assert.equal(decoded.subject.toLowerCase(), subject);
  assert.equal(decoded.mark.attrs, entry.attrs);
  assert.equal(decoded.mark.issuer.toLowerCase(), entry.issuer);
  assert.equal(verifyInclusion(call.root, rosterLeaf(entry), call.args[2]), true);
});

test('witness encoding rejects legacy, forged record, zero and absent subject', () => {
  assert.throws(() => encodeRosterWitness({ ...record, rosterAuthVersion: undefined }, subject), /Legacy/);
  assert.throws(() => encodeRosterWitness({ ...record, root: ethers.ZeroHash }, subject), /does not match/);
  assert.throws(() => encodeRosterWitness(record, ethers.ZeroAddress), /invalid/);
  assert.throws(() => encodeRosterWitness(record, entry.issuer), /absent/);
});

test('witness capability is checked in addition to roster, epoch and issuer authorization', async () => {
  const provider = (witness: number | null) => ({ call: async ({ data }: { data: string }) => {
    const witnessCall = data === ethers.id('ROSTER_WITNESS_VERSION()').slice(0, 10);
    if (witnessCall && witness === null) throw new Error('legacy');
    const version = witnessCall ? witness : data === ethers.id('ROSTER_AUTH_VERSION()').slice(0, 10) ? 1 : 2;
    return ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [version]);
  } }) as unknown as ethers.Provider;
  await requireRosterWitness(provider(1), subject);
  for (const version of [0, 2, null]) await assert.rejects(requireRosterWitness(provider(version), subject), /unsupported or unavailable/);
});
