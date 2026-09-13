import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { EPOCH_POLICY_ABI, checkEpochPolicies, expectedDemoIssuer } from './epoch-policy.js';

function fixture() {
  const issuer = ethers.getAddress('0x' + '12'.repeat(20)), registry = ethers.getAddress('0x' + '34'.repeat(20));
  const policies = [1, 2].map(id => [65572, 2, id === 1 ? 2592000 : 604800, id, 410, issuer, true, true]);
  const frozen = [true, true], kinds = [1, 1], versions = { ATTRS_SCHEMA_VERSION: 0, POLICY_SCHEMA_VERSION: 2 };
  const tags: unknown[] = [], abi = new ethers.Interface(EPOCH_POLICY_ABI);
  const provider = { call: async (tx: { data: string; blockTag: unknown }) => {
    const call = abi.parseTransaction({ data: tx.data })!; tags.push(tx.blockTag);
    const index = call.args.length ? Number(call.args[0]) - 1 : -1;
    const result = call.name === 'policies' ? policies[index] : [call.name === 'policyFrozen' ? frozen[index]
      : call.name === 'policyKind' ? kinds[index] : versions[call.name as keyof typeof versions]];
    return abi.encodeFunctionResult(call.name, result);
  } } as unknown as ethers.Provider;
  return { provider, issuer, registry, policies, frozen, kinds, versions, tags };
}

test('exact demo policies require independent issuer and report every observed field at one block', async () => {
  const f = fixture(); const result = await checkEpochPolicies(f.provider, f.registry, f.issuer, 55);
  assert.equal(result.expectedIssuer, f.issuer); assert.deepEqual(result.policies.map(p => p.maxAge), [2592000, 604800]);
  assert.ok(result.policies.every(p => p.frozen && p.exists && p.requireRoster && p.kind === 1));
  assert.equal(f.tags.length, 8); assert.ok(f.tags.every(tag => tag === 55));
  for (const raw of [undefined, '', 'not-address', ethers.ZeroAddress]) assert.throws(() => expectedDemoIssuer(raw), /DEMO_EXPECTED_ISSUER_REQUIRED/);
  await assert.rejects(checkEpochPolicies(f.provider, f.registry, f.issuer, 0), /EPOCH_POLICY_BLOCK_INVALID/);
});

test('either policy field, wildcard issuer, unfrozen state, kind or schema drift fails closed', async () => {
  for (const policy of [0, 1]) {
    const alternatives = [0, 1, 0, 0, 0, ethers.ZeroAddress, false, false];
    for (let field = 0; field < alternatives.length; field++) {
      const f = fixture(); f.policies[policy][field] = alternatives[field];
      await assert.rejects(checkEpochPolicies(f.provider, f.registry, f.issuer, 55), /EPOCH_POLICY_MISMATCH/);
    }
    const unfrozen = fixture(); unfrozen.frozen[policy] = false;
    await assert.rejects(checkEpochPolicies(unfrozen.provider, unfrozen.registry, unfrozen.issuer, 55), /EPOCH_POLICY_MISMATCH/);
    const entity = fixture(); entity.kinds[policy] = 2;
    await assert.rejects(checkEpochPolicies(entity.provider, entity.registry, entity.issuer, 55), /EPOCH_POLICY_MISMATCH/);
  }
  for (const name of ['ATTRS_SCHEMA_VERSION', 'POLICY_SCHEMA_VERSION'] as const) {
    const f = fixture(); f.versions[name]++;
    await assert.rejects(checkEpochPolicies(f.provider, f.registry, f.issuer, 55), /EPOCH_POLICY_SCHEMA_MISMATCH/);
  }
});
