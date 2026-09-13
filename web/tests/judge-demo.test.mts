import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstReason, isChainState, policyVerdict } from '../components/demo/DemoJourney';

const policy = (overrides: Record<string, unknown> = {}) => ({
  id: 1, name: 'Fixture policy', verified: false, frozen: true, requireRoster: false,
  requireAll: 1, minAssurance: 1, requiredRegime: 1, maxAge: 60,
  diagnosis: 'consistent', reasonCodes: ['WRONG_REGIME'], decisionMark: { methods: 1 },
  ...overrides,
});

const response = (overrides: Record<string, unknown> = {}) => ({
  subject: '0x0000000000000000000000000000000000000001', blockNumber: 42,
  tombstone: false,
  observation: { blockHash: `0x${'11'.repeat(32)}`, timestamp: 1_700_000_000 },
  mark: { methods: 1, methodsHex: '0x1', status: 1, regime: 2, assurance: 2, jurisdiction: 410, origin: 1 },
  asc: { sourceContract: '0x0000000000000000000000000000000000000002', expectedChainKey: 1 },
  epoch: { fresh: true, latestEpoch: 2, validUntil: 1_800_000_000 },
  policies: [policy(), policy({ id: 2, name: 'Fixture policy 2' })],
  ...overrides,
});

test('judge demo accepts only the complete response surface it renders', () => {
  assert.equal(isChainState(response()), true);
  assert.equal(isChainState(response({ policies: [policy()] })), false);
  assert.equal(isChainState(response({ policies: [policy({ reasonCodes: 'WRONG_REGIME' }), policy({ id: 2 })] })), false);
  assert.equal(isChainState(response({ asc: { expectedChainKey: 1 } })), false);
  assert.equal(isChainState(response({ observation: { blockHash: '0xdead' } })), false);
  assert.equal(isChainState(response({ tombstone: undefined })), false);
});

test('an unexplained chain boolean is never painted as a PASS', () => {
  assert.deepEqual(policyVerdict(policy({ verified: true, diagnosis: 'unexplained' }) as never), {
    label: 'CHAIN TRUE', tone: 'warn', reliable: false,
  });
  assert.deepEqual(policyVerdict(policy({ verified: false, diagnosis: 'unavailable' }) as never), {
    label: 'CHAIN FALSE', tone: 'warn', reliable: false,
  });
});

test('failed policy gives a human reason and a safe next action', () => {
  const reason = firstReason(policy() as never);
  assert.match(reason.human, /required verification environment/i);
  assert.match(reason.action, /Production access requires verification through an approved production provider/i);
});
