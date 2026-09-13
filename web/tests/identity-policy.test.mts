import { test } from 'node:test';
import assert from 'node:assert/strict';

const { identityPolicyForIssuance } = await import('../lib/identity-policy-server');

test('demo uses an explicit synthetic non-face policy; production requires an approved customer mapping', () => {
  const previous = process.env.IDENTITY_POLICY_JSON;
  try {
    delete process.env.IDENTITY_POLICY_JSON;
    const demo = identityPolicyForIssuance(true);
    assert.equal(demo.status, 'synthetic');
    assert.equal(demo.biometrics.mode, 'prohibited');
    assert.throws(() => identityPolicyForIssuance(false), /approved customer identity policy mapping/);

    process.env.IDENTITY_POLICY_JSON = JSON.stringify({ ...demo, status: 'approved', approvalRef: 'customer:approval:2026-09-07',
      policyId: 'customer-individual-nonface-v1', customerRiskId: 'customer-risk-tier-1' });
    const approved = identityPolicyForIssuance(false);
    assert.equal(approved.status, 'approved');
    assert.equal(approved.approvalRef, 'customer:approval:2026-09-07');

    process.env.IDENTITY_POLICY_JSON = JSON.stringify({ ...approved, status: 'synthetic', approvalRef: null });
    assert.throws(() => identityPolicyForIssuance(false), /approved status/);
  } finally {
    if (previous === undefined) delete process.env.IDENTITY_POLICY_JSON;
    else process.env.IDENTITY_POLICY_JSON = previous;
  }
});
