import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { groupSourceEvents, requireAtomicReceipts, requireIssuerKeyProvenance, requireDenialCorrection } from './source-events.js';

const source = '0x' + '11'.repeat(20);
const iface = new Interface(['event MarkIssued(address indexed subject, bytes32 indexed attrs, address indexed issuer, bytes32 claimsRoot, bytes32 evidenceHash)',
  'event KeyedMarkIssued(address indexed subject,bytes32 indexed attrs,address indexed issuer,uint64 issuerKeyEpoch,bytes32 claimsRoot,bytes32 evidenceHash)',
  'event MarkRevoked(address indexed subject, uint16 indexed reasonCode, uint32 indexed epoch)',
  'event RosterEpochPublished(uint32 indexed epoch, bytes32 indexed root, uint32 indexed listVersion, uint40 validUntil, uint40 sourceCutoff, uint40 publishedAt, bytes32 snapshotId)',
  'event IssuerKeyCompromised(address indexed issuer,uint64 indexed issuerKeyEpoch,uint64 lastTrustedBlock,bytes32 reasonHash)',
  'event SanctionDenialCorrected(address indexed subject,uint64 indexed denialRevision,uint256 indexed correctionId,bytes32 reasonHash,address proposer,address approver)',
  'event IssuerSet(address indexed account, bool allowed)']);
const zero = '0x' + '00'.repeat(32);
const log = (name: string, values: unknown[], index: number, transactionHash = '0xtx') => ({
  ...iface.encodeEventLog(iface.getEvent(name)!, values), address: source, index, blockNumber: 100, transactionHash,
});

test('mixed receipt, duplicate subject and multiple epochs produce one executable job in log order', () => {
  const logs = [log('MarkIssued', [source, zero, source, zero, zero], 1), log('MarkRevoked', [source, 2, 0], 2),
    log('MarkIssued', [source, zero, source, zero, zero], 3), log('RosterEpochPublished', [1, zero, 1, 1000, 1, 1, zero], 4),
    log('RosterEpochPublished', [2, zero, 1, 1000, 1, 1, zero], 5)];
  const jobs = groupSourceEvents(logs.reverse(), source, iface);
  assert.deepEqual(jobs, [{ txHash: '0xtx', blockNumber: 100, action: 0, eventName: 'MarkIssued+MarkRevoked+RosterEpochPublished', logCount: 5 }]);
});

test('foreign and operational logs cannot choose the action; distinct source transactions remain separate', () => {
  const jobs = groupSourceEvents([log('IssuerSet', [source, true], 0),
    { ...log('MarkIssued', [source, zero, source, zero, zero], 1), address: '0x' + '22'.repeat(20) },
    log('MarkRevoked', [source, 2, 0], 2), log('RosterEpochPublished', [1, zero, 1, 1000, 1, 1, zero], 3, '0xother')], source, iface);
  assert.equal(jobs.length, 2); assert.equal(jobs[0].action, 1); assert.equal(jobs[0].logCount, 1); assert.equal(jobs[1].action, 3);
});

test('keyed issuance and compromise declarations are durable worker jobs with protocol actions', () => {
  const keyed = log('KeyedMarkIssued', [source, zero, source, 7, zero, zero], 1, '0xkeyed');
  const compromised = log('IssuerKeyCompromised', [source, 7, 99, zero.replace(/.$/, '1')], 2, '0xincident');
  assert.deepEqual(groupSourceEvents([compromised, keyed], source, iface), [
    { txHash: '0xkeyed', blockNumber: 100, action: 0, eventName: 'KeyedMarkIssued', logCount: 1 },
    { txHash: '0xincident', blockNumber: 100, action: 4, eventName: 'IssuerKeyCompromised', logCount: 1 },
  ]);
});

test('governed denial correction is a durable action-5 job', () => {
  const corrected = log('SanctionDenialCorrected', [source, 3, 9, zero.replace(/.$/, '1'), source, '0x' + '33'.repeat(20)], 1, '0xcorrected');
  assert.deepEqual(groupSourceEvents([corrected], source, iface), [
    { txHash: '0xcorrected', blockNumber: 100, action: 5, eventName: 'SanctionDenialCorrected', logCount: 1 },
  ]);
});

test('worker requires explicit atomic-receipt v2 and fails closed against old or unavailable ASC', async () => {
  await requireAtomicReceipts(async () => 2n);
  await assert.rejects(requireAtomicReceipts(async () => 1n), /unsupported/);
  await assert.rejects(requireAtomicReceipts(async () => 3n), /unsupported/);
  await assert.rejects(requireAtomicReceipts(async () => { throw new Error('missing selector'); }), /migrate/);
});

test('worker requires issuer-key provenance on both source and ASC', async () => {
  await requireIssuerKeyProvenance(async () => 1n, async () => 1n);
  await assert.rejects(requireIssuerKeyProvenance(async () => 0n, async () => 1n), /unsupported/);
  await assert.rejects(requireIssuerKeyProvenance(async () => 1n, async () => { throw new Error('missing'); }), /migrate/);
});

test('worker requires denial-correction governance on both source and ASC', async () => {
  await requireDenialCorrection(async () => 1n, async () => 1n);
  await assert.rejects(requireDenialCorrection(async () => 0n, async () => 1n), /unsupported/);
  await assert.rejects(requireDenialCorrection(async () => 1n, async () => { throw new Error('missing'); }), /migrate/);
});
