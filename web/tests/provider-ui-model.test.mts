import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { parseProviderObservation, PROVIDER_COPY } = createRequire(import.meta.url)('../app/verify/provider/model.ts');
const subject = '0x0000000000000000000000000000000000000011';
const fixture = { schema: 'proofmark-sumsub-evidence-v1', provider: 'sumsub', environment: 'sandbox', subject,
  decision: 'approved', methods: 0, jurisdiction: null, methodMapping: 'pending-step-evidence', observedAt: 1_900_000_000_000 };

test('provider UI keeps overall approval separate from credential and asset eligibility', () => {
  assert.equal(parseProviderObservation(fixture, subject, 'sandbox').decision, 'approved');
  assert.match(PROVIDER_COPY.approved.detail, /no asset eligibility is granted/);
  for (const patch of [{ methods: 4 }, { jurisdiction: 410 }, { environment: 'production' }, { subject: subject.replace(/11$/, '22') },
    { methodMapping: 'approved' }, { observedAt: NaN }, { observedAt: Infinity }, { decision: 'allow' }]) {
    assert.throws(() => parseProviderObservation({ ...fixture, ...patch }, subject, 'sandbox'));
  }
});
