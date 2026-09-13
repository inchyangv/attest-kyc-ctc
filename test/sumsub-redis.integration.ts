import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { RedisSumsubStateStore, SumsubStateError } from '../pipeline/providers/sumsub-redis.js';
import type { SumsubEvidenceCandidate } from '../pipeline/providers/sumsub.js';
import type { SumsubSessionRecord } from '../pipeline/providers/sumsub-state.js';

const exec = promisify(execFile);
const container = process.env.TEST_REDIS_CONTAINER;
if (!container || !/^proofmark-bank-test-[a-zA-Z0-9-]+$/.test(container)) {
  throw new Error('Use node scripts/test-bank-redis.mjs test/sumsub-redis.integration.ts.');
}

const secret = 'synthetic-sumsub-state-key-at-least-32-characters';
const bridge = (async (_url, init) => {
  const args = JSON.parse(String(init?.body)) as (string | number)[];
  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--json', ...args.map(String)], {
    maxBuffer: 1_000_000,
  });
  return Response.json({ result: JSON.parse(stdout) });
}) as typeof fetch;

const store = (namespace: string, request: typeof fetch = bridge) =>
  new RedisSumsubStateStore('https://synthetic-redis.test', 'synthetic-token', secret, 3_600, request, namespace);

const session = (externalUserId = `pm-sbx-${randomUUID()}`): SumsubSessionRecord => ({
  version: 1,
  revision: 1,
  externalUserId,
  environment: 'sandbox',
  walletAddress: '0x00000000000000000000000000000000000a11ce',
  flowId: `flow-${randomUUID()}`,
  levelName: 'proofmark-synthetic',
  identityPolicyId: 'synthetic-identity-v1',
  processingPolicyFingerprint: '11'.repeat(32),
  retentionPolicyFingerprint: '22'.repeat(32),
  createdAt: 1_900_000_000_000,
  expiresAt: 2_000_000_000_000,
});

const evidence = (
  record: SumsubSessionRecord,
  changes: Partial<SumsubEvidenceCandidate> = {},
): SumsubEvidenceCandidate => ({
  schema: 'proofmark-sumsub-evidence-v1',
  provider: 'sumsub',
  environment: 'sandbox',
  environmentEvidence: 'configured-credentials',
  subject: record.walletAddress.toLowerCase(),
  flowIdHash: `0x${'31'.repeat(32)}`,
  externalUserIdHash: `0x${'32'.repeat(32)}`,
  applicantIdHash: `0x${'33'.repeat(32)}`,
  inspectionIdHash: null,
  levelName: record.levelName,
  methodMapping: 'pending-step-evidence',
  methods: 0,
  methodNames: [],
  jurisdictionAlpha3: null,
  jurisdiction: null,
  decision: 'approved',
  reviewStatus: 'completed',
  reviewAnswer: 'GREEN',
  reviewRejectType: null,
  observedAt: 1_900_000_000_000,
  providerReviewedAt: 1_900_000_000_000,
  webhookFence: null,
  processingPolicyFingerprint: record.processingPolicyFingerprint,
  retentionPolicyFingerprint: record.retentionPolicyFingerprint,
  evidenceHash: `0x${'44'.repeat(32)}`,
  ...changes,
});

const rejected = (record: SumsubSessionRecord, eventAt: number) =>
  evidence(record, {
    decision: 'rejected',
    reviewAnswer: 'RED',
    reviewRejectType: 'FINAL',
    observedAt: eventAt,
    providerReviewedAt: null,
    webhookFence: { eventAt, type: 'applicantReviewed', reason: 'PROVIDER_REJECTION' },
    evidenceHash: `0x${'55'.repeat(32)}`,
  });

const code = (expected: string) => (error: unknown) =>
  error instanceof SumsubStateError && error.code === expected;

test('real Redis CAS prevents a stale GREEN snapshot from replacing committed RED', async () => {
  const namespace = `sumsub-${randomUUID()}`;
  const state = store(namespace);
  const record = session();
  assert.equal(await state.create(record), 'fresh');
  const first = await state.get(record.externalUserId);
  const stale = await state.get(record.externalUserId);
  assert.equal(first?.revision, 1);
  assert.equal(stale?.revision, 1);

  await state.saveObservation(record.externalUserId, rejected(record, 1_900_000_001_000), first!.revision);
  await assert.rejects(
    state.saveObservation(record.externalUserId, evidence(record), stale!.revision),
    code('SUMSUB_REVISION_CONFLICT'),
  );
  const committed = await store(namespace).get(record.externalUserId);
  assert.equal(committed?.revision, 2);
  assert.equal(committed?.latest?.decision, 'rejected');
  assert.equal(committed?.latest?.reviewAnswer, 'RED');
});

test('atomic webhook beats a stale status save; duplicate and older delivery cannot regress it', async () => {
  const namespace = `sumsub-${randomUUID()}`;
  const state = store(namespace);
  const record = session();
  await state.create(record);
  const staleStatus = await state.get(record.externalUserId);
  const eventAt = 1_900_000_002_000;
  const digest = 'a'.repeat(64);
  const applicantIdHash = `0x${'ab'.repeat(32)}`;

  assert.equal(
    await state.applyWebhook(record.externalUserId, digest, eventAt, applicantIdHash, rejected(record, eventAt)),
    'fresh',
  );
  await assert.rejects(
    state.saveObservation(
      record.externalUserId,
      evidence(record, { providerReviewedAt: eventAt + 1 }),
      staleStatus!.revision,
    ),
    code('SUMSUB_REVISION_CONFLICT'),
  );
  assert.equal(
    await store(namespace).applyWebhook(
      record.externalUserId,
      digest,
      eventAt,
      applicantIdHash,
      rejected(record, eventAt),
    ),
    'duplicate',
  );
  assert.equal(
    await store(namespace).applyWebhook(
      record.externalUserId,
      'b'.repeat(64),
      eventAt - 1,
      applicantIdHash,
      rejected(record, eventAt - 1),
    ),
    'stale',
  );
  const committed = await state.get(record.externalUserId);
  assert.equal(committed?.latest?.decision, 'rejected');
  assert.equal(committed?.latest?.webhookFence?.eventAt, eventAt);
});

test('lost webhook response is retry-safe because state and replay claim commit together', async () => {
  const namespace = `sumsub-${randomUUID()}`;
  const record = session();
  await store(namespace).create(record);
  const eventAt = 1_900_000_003_000;
  const digest = 'c'.repeat(64);
  let drop = true;
  const dropAfterCommit = (async (url, init) => {
    const args = JSON.parse(String(init?.body)) as (string | number)[];
    const result = await bridge(url, init);
    const keyCount = Number(args[2]);
    if (args[3 + keyCount] === 'webhook' && drop) {
      drop = false;
      throw new Error('synthetic response loss after Redis commit');
    }
    return result;
  }) as typeof fetch;

  await assert.rejects(
    store(namespace, dropAfterCommit).applyWebhook(
      record.externalUserId,
      digest,
      eventAt,
      `0x${'cd'.repeat(32)}`,
      rejected(record, eventAt),
    ),
    code('SUMSUB_STATE_UNAVAILABLE'),
  );
  assert.equal(
    await store(namespace).applyWebhook(
      record.externalUserId,
      digest,
      eventAt,
      `0x${'cd'.repeat(32)}`,
      rejected(record, eventAt),
    ),
    'duplicate',
  );
  assert.equal((await store(namespace).get(record.externalUserId))?.latest?.decision, 'rejected');
});

test('Redis stores encrypted session state and only an opaque applicant binding', async () => {
  const namespace = `sumsub-${randomUUID()}`;
  const state = store(namespace);
  const record = session();
  await state.create(record);
  const eventAt = 1_900_000_004_000;
  const rawApplicantId = 'sumsubApplicantSynthetic123';
  const applicantIdHash = `0x${createHash('sha256').update(rawApplicantId).digest('hex')}`;
  await state.applyWebhook(
    record.externalUserId,
    'd'.repeat(64),
    eventAt,
    applicantIdHash,
    rejected(record, eventAt),
  );

  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--raw', 'KEYS', `{${namespace}:sumsub:*`]);
  const keys = stdout.trim().split('\n').filter(Boolean);
  assert.ok(keys.length >= 3);
  for (const key of keys) {
    const redisType: string = (await exec('docker', ['exec', container, 'redis-cli', '--raw', 'TYPE', key])).stdout.trim();
    const value: string = redisType === 'hash'
      ? (await exec('docker', ['exec', container, 'redis-cli', '--raw', 'HGETALL', key])).stdout
      : (await exec('docker', ['exec', container, 'redis-cli', '--raw', 'GET', key])).stdout;
    assert.equal(value.includes(rawApplicantId), false);
    assert.equal(value.includes(record.walletAddress), false);
    assert.equal(value.includes(record.flowId), false);
  }
});
