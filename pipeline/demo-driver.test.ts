import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
// @ts-expect-error The executable's Node ESM helpers intentionally have no TS build step.
import { syntheticDriverPng, isIsolatedDemoStatus, assessDriverObservation } from '../deploy/demo-driver-utils.mjs';

test('driver image is deterministic PNG with compressed pixels, not random bytes in a PNG envelope', () => {
  const bytes: Buffer = syntheticDriverPng(); assert.deepEqual(bytes, syntheticDriverPng());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.readUInt32BE(16), 32); assert.equal(bytes.readUInt32BE(20), 24);
  const length = bytes.readUInt32BE(33); assert.equal(bytes.toString('ascii', 37, 41), 'IDAT');
  assert.equal(inflateSync(bytes.subarray(41, 41 + length)).length, 24 * (1 + 32 * 3));
});

test('demo flag alone or a non-live institutional testbed cannot satisfy driver preflight', () => {
  const s = { demo: true, sandboxBits: true, id: { configured: true, demo: true, live: false, vendor: 'demo:id' },
    bank: { configured: true, demo: true, live: false, vendor: 'demo:bank' }, bankState: { configured: true }, issuer: { configured: true },
    issuanceJournal: { configured: true }, tokenKey: { configured: true, mode: 'versioned-dedicated' } };
  assert.equal(isIsolatedDemoStatus(s), true);
  for (const bad of [{ ...s, id: { ...s.id, live: true } }, { ...s, bank: { ...s.bank, vendor: 'openbanking:test' } },
    { ...s, bankState: { configured: false } }, { ...s, issuanceJournal: { configured: false } },
    { ...s, tokenKey: { configured: false } }, null]) assert.equal(isIsolatedDemoStatus(bad), false);
});

test('Active Direct mark alone is not roster readiness; exact material and policy IDs are checked', () => {
  const expected = { subject: '0xsubject', issuer: '0xissuer', assurance: 3, methodsHex: '0x10024', claimsRoot: '0xclaims', evidenceHash: '0xevidence', expiry: 1900000000 };
  const mark = { ...expected, status: 1, regime: 2 };
  const oc = { subject: expected.subject, observation: { chainId: 102031 }, registry: { compatible: true, versions: { ROSTER_WITNESS_VERSION: 1 } },
    mark, tombstone: false, epoch: { latestEpoch: 3, fresh: true }, witness: { epoch: 3, issuerApproved: true, mark },
    policies: [{ id: 2, verified: true, requireRoster: true, frozen: true, diagnosis: 'consistent' },
      { id: 1, verified: false, requireRoster: true, frozen: true, diagnosis: 'consistent' }] };
  assert.equal(assessDriverObservation(oc, expected), 'api-roster-verdict-ready');
  assert.equal(assessDriverObservation({ ...oc, witness: null }, expected), 'awaiting-current-witness');
  assert.equal(assessDriverObservation({ ...oc, witness: { ...oc.witness, epoch: 2 } }, expected), 'awaiting-current-witness');
  assert.equal(assessDriverObservation({ ...oc, mark: { ...mark, status: 0 } }, expected), 'awaiting-materialization');
  assert.equal(assessDriverObservation({ ...oc, mark: { ...mark, evidenceHash: '0xanother' } }, expected), 'different-mark');
  assert.equal(assessDriverObservation({ ...oc, witness: { ...oc.witness, mark: { ...mark, expiry: 1 } } }, expected), 'different-witness');
  assert.equal(assessDriverObservation({ ...oc, tombstone: true }, expected), 'restricted');
  assert.equal(assessDriverObservation({ ...oc, registry: { compatible: false } }, expected), 'incompatible');
  assert.equal(assessDriverObservation({ ...oc, policies: {} }, expected), 'incompatible');
  assert.equal(assessDriverObservation({ ...oc, policies: [null, ...oc.policies] }, expected), 'incompatible');
  assert.equal(assessDriverObservation({ ...oc, policies: [...oc.policies, oc.policies[0]] }, expected), 'incompatible');
  assert.equal(assessDriverObservation({ ...oc, policies: [{ ...oc.policies[0], verified: 'true' }, oc.policies[1]] }, expected), 'policy-rejected');
  assert.equal(assessDriverObservation({ ...oc, witness: { ...oc.witness, issuerApproved: 'true' } }, expected), 'awaiting-current-witness');
  assert.equal(assessDriverObservation({ ...oc, epoch: { ...oc.epoch, fresh: 'true' } }, expected), 'awaiting-current-witness');
  assert.equal(assessDriverObservation({ ...oc, tombstone: null }, expected), 'incompatible');
});

test('driver requires explicit issuance execution acknowledgement before accessing the URL', () => {
  const p = spawnSync(process.execPath, ['deploy/verify-demo.mjs', 'http://localhost:1'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(p.status, 2); assert.match(p.stderr, /may spend issuer gas/); assert.doesNotMatch(p.stderr, /ECONNREFUSED/);
});
