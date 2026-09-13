import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETENTION_POLICY_SCHEMA,
  defineRetentionPolicy,
  deriveRetentionSchedule,
  retentionPolicyBinding,
  assertRetentionCompletion,
  assertRetentionBinding,
  retentionPolicyEvidence,
  retentionPolicyFingerprint,
  type RetentionPolicyV1,
} from './retention-policy.js';

const day = 86_400_000;

function policy(): RetentionPolicyV1 {
  const layers = [
    { layer: 'evidence-vault', action: 'delete', durationDays: 30, retentionRef: 'retention:vault:30d' },
    { layer: 'issuance-journal', action: 'expire', trigger: 'terminal-at', durationDays: 1, retentionRef: 'retention:journal:1d' },
    { layer: 'revocation-outbox', action: 'retain-minimized', durationDays: 90, retentionRef: 'retention:outbox:90d' },
    { layer: 'backup', action: 'expire', durationDays: 30, retentionRef: 'retention:backup:30d' },
    { layer: 'vendor', action: 'external-delete', durationDays: 30, retentionRef: 'retention:vendor:30d' },
    { layer: 'operational-log', action: 'retain-minimized', durationDays: 30, retentionRef: 'retention:logs:30d' },
    { layer: 'client-copy', action: 'client-controlled', durationDays: null, retentionRef: 'retention:client-controlled' },
    { layer: 'onchain', action: 'irreversible', durationDays: null, retentionRef: 'retention:onchain-irreversible' },
  ] as RetentionPolicyV1['rules'][number]['layers'];
  return {
    schema: RETENTION_POLICY_SCHEMA,
    policyId: 'customer-alpha-retention-v1', customerId: 'customer-alpha', jurisdiction: 'KR', status: 'approved',
    approvalRef: 'approval:retention:2026-09-07', legalReviewRef: 'legal:retention:2026-09-07',
    clockRef: 'clock:trusted-service:v1', holdAuthorityRef: 'authority:legal-hold:v1',
    rules: (['issued', 'review', 'denied', 'error'] as const).map(outcome => ({
      outcome, trigger: outcome === 'issued' ? 'decision-at' : 'collected-at',
      credentialDisposition: outcome === 'issued' ? 'source-revoked' : 'not-issued', layers,
    })),
  };
}

test('PM-T33-01 an expired vault row cannot be reported fully deleted while journal, backup, vendor, and credential effects survive', () => {
  const p = defineRetentionPolicy(policy());
  const schedule = deriveRetentionSchedule(p, {
    customerId: 'customer-alpha', jurisdiction: 'KR', outcome: 'issued', collectedAt: 100, decisionAt: 200,
  });
  assert.equal(schedule.layers.find(layer => layer.layer === 'evidence-vault')?.deleteAt, 200 + 30 * day);
  assert.throws(() => assertRetentionCompletion(schedule, {
    policyFingerprint: retentionPolicyBinding(p).fingerprint,
    checkedAt: 200 + 31 * day,
    activeHolds: [],
    credential: { disposition: 'source-revoked', sourceRevoked: false, hubEnforced: false },
    layers: [{ layer: 'evidence-vault', status: 'deleted', evidenceRef: 'vault:tombstone:synthetic' }],
  }), /RETENTION_COMPLETION_INCOMPLETE/);
});

test('outcome-specific triggers derive exact deadlines without a universal five-year fallback', () => {
  const p = defineRetentionPolicy(policy());
  const issued = deriveRetentionSchedule(p, { customerId: 'customer-alpha', jurisdiction: 'KR', outcome: 'issued', collectedAt: 100, decisionAt: 200 });
  const denied = deriveRetentionSchedule(p, { customerId: 'customer-alpha', jurisdiction: 'KR', outcome: 'denied', collectedAt: 100, decisionAt: 200 });
  assert.equal(issued.triggerAt, 200);
  assert.equal(denied.triggerAt, 100);
  assert.equal(retentionPolicyEvidence(p, { customerId: 'customer-alpha', jurisdiction: 'KR', outcome: 'issued', collectedAt: 100, decisionAt: 200 }).vaultDeleteAt, 200 + 30 * day);
  assert.notEqual(issued.layers.find(layer => layer.layer === 'evidence-vault')!.deleteAt, 200 + 1_825 * day);
  assert.throws(() => deriveRetentionSchedule(p, { customerId: 'another-customer', jurisdiction: 'KR', outcome: 'issued', collectedAt: 100, decisionAt: 200 }), /does not match/);
});

test('policy validation covers every layer/outcome and consent-bound drift fails closed', () => {
  const valid = policy();
  assert.throws(() => defineRetentionPolicy({ ...valid, rules: valid.rules.slice(1) }), /every outcome/);
  assert.throws(() => defineRetentionPolicy({ ...valid, rules: valid.rules.map((rule, index) => index === 0
    ? { ...rule, layers: rule.layers.filter(layer => layer.layer !== 'vendor') } : rule) }), /every storage\/effect layer/);
  assert.throws(() => defineRetentionPolicy({ ...valid, status: 'approved', approvalRef: null }), /requires approval/);
  const binding = retentionPolicyBinding(valid);
  const base = policy();
  const changed: RetentionPolicyV1 = { ...base, rules: base.rules.map((rule, index) => index === 0
    ? { ...rule, trigger: 'collected-at' } : rule) };
  assert.notEqual(retentionPolicyFingerprint(valid), retentionPolicyFingerprint(changed));
  assert.throws(() => assertRetentionBinding(changed, binding), /changed after wallet consent/);
});

test('complete layer evidence still fails under a hold and passes only with enforced credential disposition', () => {
  const schedule = deriveRetentionSchedule(policy(), { customerId: 'customer-alpha', jurisdiction: 'KR', outcome: 'issued', collectedAt: 100, decisionAt: 200, terminalAt: 200 });
  const observation = {
    policyFingerprint: schedule.policyFingerprint, checkedAt: 200 + 100 * day, activeHolds: [] as string[],
    credential: { disposition: 'source-revoked' as const, sourceRevoked: true, hubEnforced: true },
    layers: schedule.layers.map(layer => ({ layer: layer.layer,
      status: layer.action === 'client-controlled' ? 'client-controlled' as const
        : layer.action === 'irreversible' ? 'irreversible-residual' as const : 'deleted' as const,
      evidenceRef: `evidence:${layer.layer}:synthetic` })),
  };
  assert.doesNotThrow(() => assertRetentionCompletion(schedule, observation));
  assert.throws(() => assertRetentionCompletion(schedule, { ...observation, activeHolds: ['hold:synthetic-case'] }), /ACTIVE_HOLD/);
});
