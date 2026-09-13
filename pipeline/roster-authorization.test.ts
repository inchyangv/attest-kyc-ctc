import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { rosterApprovalData, readRootApprovals, requireRosterAuthorization } from './roster-authorization.js';

const source = '0x' + '11'.repeat(20);
const publisher = '0x' + '22'.repeat(20);
const issuer = '0x' + '33'.repeat(20);
const other = '0x' + '44'.repeat(20);
const message = { epoch: 1, root: ethers.id('root'), listVersion: 9, validUntil: 1800086400,
  sourceCutoff: 1800000000, snapshotId: ethers.id('snapshot'), publisher };

test('typed root approval binds every field, chain, source and publisher', async () => {
  const signer = ethers.Wallet.createRandom();
  const data = rosterApprovalData(11155111n, source, message);
  const sig = await signer.signTypedData(data.domain, data.types, data.value);
  assert.equal(ethers.verifyTypedData(data.domain, data.types, data.value, sig), signer.address);
  for (const changed of [{ epoch: 2 }, { root: ethers.id('other') }, { listVersion: 10 }, { validUntil: message.validUntil - 1 },
    { sourceCutoff: message.sourceCutoff - 1 }, { snapshotId: ethers.id('other') }, { publisher: other }]) {
    assert.notEqual(rosterApprovalData(11155111n, source, { ...message, ...changed }).digest, data.digest);
  }
  assert.notEqual(rosterApprovalData(1n, source, message).digest, data.digest);
  assert.notEqual(rosterApprovalData(11155111n, other, message).digest, data.digest);
  for (const changed of [{ epoch: 0 }, { epoch: 2 ** 32 }, { listVersion: -1 }, { sourceCutoff: 2 ** 40 },
    { validUntil: 1.5 }, { root: ethers.ZeroHash }, { snapshotId: '0x01' }, { publisher: ethers.ZeroAddress }]) {
    assert.throws(() => rosterApprovalData(11155111n, source, { ...message, ...changed }), /invalid/);
  }
});

test('approval envelope is exact-bound, sorted, unique and covers every roster issuer', () => {
  const digest = rosterApprovalData(11155111n, source, message).digest;
  // Empty 1271 signatures are shape-valid, not authenticated until the source static call.
  const envelope = { version: 1, digest, approvals: [{ issuer: other, signature: '0x' }, { issuer, signature: '0x01' }] };
  assert.deepEqual(readRootApprovals(envelope, digest, [issuer, other]).map(a => a.issuer.toLowerCase()), [issuer, other]);
  for (const changed of [{ version: 0 }, { digest: ethers.id('other') }, { approvals: [] },
    { approvals: Array(17).fill(envelope.approvals[0]) }, { approvals: [envelope.approvals[0], envelope.approvals[0]] },
    { approvals: [{ issuer, signature: '0x' + 'ab'.repeat(4097) }] }, { approvals: [{ issuer, signature: '0xa' }] },
    { approvals: [{ issuer: ethers.ZeroAddress, signature: '0x' }] }, { approvals: [null] }]) {
    assert.throws(() => readRootApprovals({ ...envelope, ...changed }, digest, [issuer]));
  }
  assert.throws(() => readRootApprovals(envelope, digest, [publisher]), /not covered/);
  assert.throws(() => readRootApprovals(null, digest, []), /invalid/);
});

test('authorization compatibility rejects unavailable, mixed and unknown contracts', async () => {
  await requireRosterAuthorization(async () => 1n, async () => 1n, async () => 1n);
  await assert.rejects(requireRosterAuthorization(), /target required/);
  await assert.rejects(requireRosterAuthorization(async () => 1n, async () => 2n), /unsupported/);
  await assert.rejects(requireRosterAuthorization(async () => { throw new Error('old contract'); }), /unavailable/);
});
