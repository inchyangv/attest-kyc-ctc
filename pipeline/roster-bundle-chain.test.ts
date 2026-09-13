import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { exportRosterBundle, loadRosterBundle } from './roster-bundle.js';
import { checkBundleProof, BUNDLE_CHECK_ABIS } from './roster-bundle-chain.js';
import { bundleFixture } from '../test/fixtures/roster-bundle.js';

function setup() {
  const { record, scope } = bundleFixture(); const out = exportRosterBundle(record, scope);
  const loaded = loadRosterBundle(out.bytes, out.contentHash), proof = loaded.proof(record.entries[0].subject);
  const calls: { name: string; blockTag: unknown }[] = [];
  const values: Record<string, unknown> = { ATTRS_SCHEMA_VERSION: 0, TRANSACTION_PROCESSING_VERSION: 2, EPOCH_SCHEMA_VERSION: 2,
    ROSTER_AUTH_VERSION: 1, ISSUER_KEY_PROVENANCE_VERSION: 1, ROSTER_FORMAT_VERSION: 2, ROSTER_WITNESS_VERSION: 1, POLICY_SCHEMA_VERSION: 2,
    ASC: scope.asc, sourceContract: scope.source, expectedChainKey: scope.sourceChainKey, latestEpoch: record.epoch,
    epochRoots: record.root, epochSourceCutoff: record.sourceCutoff, epochPublishedAt: record.publishedAt,
    epochValidUntil: record.validUntil, epochSnapshotId: record.snapshotId, epochListVersion: record.listVersion,
    isRosterFresh: true, epochIssuerApproved: true, isEpochIssuerUsable: true, policyFrozen: true, policyRequiresRoster: true, verifyWithRoster: true, proveNotInRoster: true };
  let fork = false;
  const registryAbi = new ethers.Interface(BUNDLE_CHECK_ABIS.registry), ascAbi = new ethers.Interface(BUNDLE_CHECK_ABIS.asc);
  const provider = {
    getNetwork: async () => ({ chainId: 102031n }),
    getBlock: async (tag: unknown) => ({ number: 55, hash: fork && tag === 55 ? ethers.id('fork') : ethers.id('block'), timestamp: record.publishedAt + 1 }),
    call: async (tx: { to: string; data: string; blockTag: unknown }) => {
      const abi = tx.to.toLowerCase() === scope.registry.toLowerCase() ? registryAbi : ascAbi;
      const name = abi.getFunction(tx.data.slice(0, 10))!.name;
      calls.push({ name, blockTag: tx.blockTag });
      if (name === 'cacheRosterWitness') return '0x';
      return abi.encodeFunctionResult(name, [values[name]]);
    },
  } as unknown as ethers.Provider;
  return { record, scope, proof, loaded, calls, values, provider, reorg: () => { fork = true; } };
}

test('bundle online check pins every call and re-encodes the checked witness rather than trusting response calldata', async () => {
  const f = setup(); if (f.proof.kind !== 'inclusion') throw Error('fixture');
  f.proof.transaction.to = ethers.ZeroAddress; f.proof.transaction.data = '0xdeadbeef';
  const checked = await checkBundleProof(f.provider, f.scope, f.proof, 2n);
  assert.equal(checked.proofAccepted, true); assert.equal(checked.eligible, true); assert.equal(checked.witnessSimulation, 'succeeded');
  assert.equal(checked.transaction?.to, f.scope.registry);
  assert.notEqual(checked.transaction?.data, '0xdeadbeef');
  assert.ok(f.calls.length > 20);
  assert.ok(f.calls.every(c => c.blockTag === 55));
});

test('new epoch with identical root, stale metadata, role/policy mismatch, unknown schema and reorg fail closed', async () => {
  for (const [name, value] of Object.entries({ latestEpoch: 2, isRosterFresh: false, epochSnapshotId: ethers.id('other'), epochSourceCutoff: 1,
    isEpochIssuerUsable: false, policyFrozen: false, policyRequiresRoster: false, ROSTER_AUTH_VERSION: 2,
    sourceContract: ethers.ZeroAddress, ASC: ethers.ZeroAddress, expectedChainKey: 3 })) {
    const f = setup(); f.values[name] = value;
    await assert.rejects(checkBundleProof(f.provider, f.scope, f.proof, 2n), /./, name);
  }
  const f = setup(); f.reorg();
  await assert.rejects(checkBundleProof(f.provider, f.scope, f.proof, 2n), /reorganized/);
  const wrong = setup();
  await assert.rejects(checkBundleProof(wrong.provider, { ...wrong.scope, registry: ethers.ZeroAddress }, wrong.proof, 2n), /trusted consumer/);
});

test('policy rejection creates no witness request and successful absence is explicitly not an eligibility verdict', async () => {
  const f = setup(); f.values.verifyWithRoster = false;
  const rejected = await checkBundleProof(f.provider, f.scope, f.proof, 2n);
  assert.equal(rejected.proofAccepted, false); assert.equal(rejected.eligible, false); assert.equal(rejected.transaction, undefined);
  assert.ok(!f.calls.some(c => c.name === 'cacheRosterWitness'));
  const absence = await checkBundleProof(f.provider, f.scope, f.loaded.proof(ethers.toBeHex(999, 20)), 2n);
  assert.equal(absence.kind, 'non-inclusion'); assert.equal(absence.proofAccepted, true); assert.equal(absence.eligible, false);
  assert.equal(absence.transaction, undefined); assert.match(absence.meaning, /not-a-sanction/);
});
