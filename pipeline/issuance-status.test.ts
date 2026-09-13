import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import type { IssuanceEntry } from './issuance-journal.js';
import { issuanceProgress, type IssuanceTrackingConfig } from './issuance-status.js';

const tracking: IssuanceTrackingConfig = { configured: true, sourceExpectedSeconds: [10, 30], hubExpectedSeconds: [20, 60],
  timeoutSeconds: 120, supportUrl: 'https://support.example.test/issuance', missing: [], invalid: [] };
const entry = (): IssuanceEntry => ({ version: 1, requestId: ethers.id('request'), wallet: ethers.Wallet.createRandom().address,
  fingerprint: ethers.id('input'), consentVersion: 'proofmark-kyc-v3', createdAt: 1_000, prepareUntil: 901_000,
  phase: 'prepared', target: { chainId: 11155111, hubChainId: 102031, source: ethers.Wallet.createRandom().address,
    asc: ethers.Wallet.createRandom().address, issuer: ethers.Wallet.createRandom().address }, assurance: 3, evidenceStored: true,
  revertedTransactions: [], outcome: { status: 'ISSUED', attrs: ethers.ZeroHash, claimsRoot: ethers.id('claims'), evidenceHash: ethers.id('evidence'),
    claims: [], evidence: [], methods: 0, methodNames: [], expiry: 2_000_000_000, regime: 2 } });

test('source, CC3 and policy remain distinct with bounded timing and support metadata', () => {
  const value = entry(); value.phase = 'source-confirmed';
  value.sourceConfirmation = { blockNumber: 12, blockHash: ethers.id('block'), transactionIndex: 1, confirmedAt: 20_000 };
  const progress = issuanceProgress(value, null, tracking, 25_000);
  assert.equal(progress.source.state, 'confirmed'); assert.equal(progress.attestation.state, 'waiting');
  assert.equal(progress.policy.state, 'waiting-attestation'); assert.equal(progress.assetAction.ready, false);
  assert.equal(progress.timing.source.expectedBy, 31_000); assert.equal(progress.timing.attestation.expectedBy, 80_000);
  assert.equal(progress.timing.timeoutAt, 121_000); assert.equal(progress.nextAction, 'resume');
});

test('historical CC3 materialization requires a current exact-policy PASS before asset readiness', () => {
  const value = entry(); value.phase = 'materialized'; value.materializedAt = 30_000;
  value.sourceConfirmation = { blockNumber: 12, blockHash: ethers.id('block'), transactionIndex: 1, confirmedAt: 20_000 };
  const denied = issuanceProgress(value, { status: 'observed', blockNumber: 40, blockHash: ethers.id('hub-block'), observedAt: 31_000,
    policies: [{ id: 1, name: 'production', verified: false, reasonCodes: ['WRONG_REGIME'] },
      { id: 2, name: 'pilot', verified: false, reasonCodes: ['AWAITING_ROSTER_WITNESS'] }] }, tracking, 31_000);
  assert.equal(denied.policy.state, 'ineligible'); assert.equal(denied.assetAction.ready, false);
  const allowed = issuanceProgress(value, { status: 'observed', blockNumber: 41, blockHash: ethers.id('hub-block-2'), observedAt: 32_000,
    policies: [{ id: 2, name: 'pilot', verified: true, reasonCodes: [] }] }, tracking, 32_000);
  assert.equal(allowed.policy.state, 'eligible'); assert.deepEqual(allowed.assetAction.readyPolicyIds, [2]);
});

test('revert and unavailable Registry observations fail closed with an explicit next action', () => {
  const reverted = entry(); reverted.phase = 'failed'; reverted.lastError = 'SOURCE_REVERTED';
  assert.deepEqual(issuanceProgress(reverted, null, tracking).assetAction.readyPolicyIds, []);
  assert.equal(issuanceProgress(reverted, null, tracking).nextAction, 'retry');
  const materialized = entry(); materialized.phase = 'materialized'; materialized.materializedAt = 10_000;
  const unavailable = issuanceProgress(materialized, { status: 'unavailable', code: 'POLICY_STATUS_UNAVAILABLE' }, tracking);
  assert.equal(unavailable.policy.state, 'unavailable'); assert.equal(unavailable.assetAction.ready, false);
});
