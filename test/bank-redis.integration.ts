import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { BankStateError, RedisBankStateStore, type BankReservation } from '../pipeline/bank-state.js';

const exec = promisify(execFile);
const container = process.env.TEST_REDIS_CONTAINER;
if (!container || !/^proofmark-bank-test-[a-zA-Z0-9-]+$/.test(container)) throw new Error('Use npm run test:bank-redis to create an isolated Redis instance.');
const namespace = `test-${randomUUID()}`;
// Only the HTTP transport is substituted. The exact production Lua executes in real Redis.
const bridge = (async (_url, init) => {
  const args = JSON.parse(String(init?.body)) as (string | number)[];
  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--json', ...args.map(String)], { maxBuffer: 1_000_000 });
  return Response.json({ result: JSON.parse(stdout) });
}) as typeof fetch;
const store = () => new RedisBankStateStore('https://synthetic-redis.test', 'synthetic-token', bridge, namespace);
const reservation = (changes: Partial<BankReservation> = {}): BankReservation => ({
  requestKey: randomUUID(), flowKey: randomUUID(), accountKey: randomUUID(), walletKey: randomUUID(), fingerprint: randomUUID(), challengeId: randomUUID(), ...changes,
});
const code = (expected: string) => (error: unknown) => error instanceof BankStateError && error.code === expected;

test('two independent application stores share one five-attempt limit in real Redis', async () => {
  const a = store(); const b = store(); const input = reservation();
  await a.reserve(input); await a.activate(input, 'encrypted-response');
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).verify(input, false)));
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal(attempts.filter(r => r.status === 'rejected' && code('TOO_MANY_ATTEMPTS')(r.reason)).length, 16);
  await assert.rejects(store().verify(input, true), code('TOO_MANY_ATTEMPTS'));
});

test('concurrent reserves have one owner, cached response survives a fresh client, payload conflicts', async () => {
  const input = reservation(); const a = store();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => store().reserve(input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(a.reserve({ ...input, fingerprint: randomUUID() }), code('CONFLICT'));
  await a.activate(input, 'encrypted-original-response');
  assert.deepEqual(await store().reserve({ ...input, challengeId: randomUUID() }), { status: 'cached', response: 'encrypted-original-response' });
  const successes = await Promise.allSettled(Array.from({ length: 10 }, () => store().verify(input, true)));
  assert.equal(successes.filter(r => r.status === 'fulfilled').length, 1);
});

test('supersession, expired state and cross-instance account budgets fail closed', async () => {
  const a = store(); const old = reservation();
  await a.reserve(old); await a.activate(old, 'encrypted-old');
  const next = reservation({ flowKey: old.flowKey }); await a.reserve(next); await a.activate(next, 'encrypted-next');
  await assert.rejects(store().verify(old, true), code('CHALLENGE_UNAVAILABLE'));
  await exec('docker', ['exec', container, 'redis-cli', 'HSET', `{${namespace}:bank}:request:${next.requestKey}`, 'expires', '1']);
  await assert.rejects(store().verify(next, true), code('CHALLENGE_EXPIRED'));
  const accountKey = randomUUID();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => store().reserve(reservation({ accountKey }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  assert.equal(results.filter(r => r.status === 'rejected' && code('START_BUDGET_EXCEEDED')(r.reason)).length, 9);
});
