import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BANK_LIMITS, BankStateError, DemoBankStateStore, RedisBankStateStore, type BankReservation } from './bank-state.js';

const reservation = (changes: Partial<BankReservation> = {}): BankReservation => ({
  requestKey: randomUUID(), flowKey: randomUUID(), accountKey: randomUUID(), walletKey: randomUUID(),
  fingerprint: randomUUID(), challengeId: randomUUID(), ...changes,
});
const code = (expected: string) => (error: unknown) => error instanceof BankStateError && error.code === expected;

test('original challenge cannot reset five failures, including concurrent requests', async () => {
  const store = new DemoBankStateStore();
  const input = reservation();
  await store.reserve(input); await store.activate(input, 'encrypted-response');
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => store.verify(input, false)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 4);
  assert.equal(results.filter(r => r.status === 'rejected' && code('TOO_MANY_ATTEMPTS')(r.reason)).length, 16);
  await assert.rejects(store.verify(input, true), code('TOO_MANY_ATTEMPTS'));
});

test('success is single-use and a lost sandbox instance cannot reconstruct state', async () => {
  const store = new DemoBankStateStore(); const input = reservation();
  await store.reserve(input); await store.activate(input, 'encrypted-response');
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.verify(input, true)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(new DemoBankStateStore().verify(input, true), code('CHALLENGE_UNAVAILABLE'));
});

test('expired and superseded challenges fail; replay does not extend their lifetime', async () => {
  let now = 1000; const store = new DemoBankStateStore(() => now);
  const input = reservation(); await store.reserve(input); await store.activate(input, 'encrypted-response');
  assert.deepEqual(await store.reserve(input), { status: 'cached', response: 'encrypted-response' });
  now += BANK_LIMITS.lifetimeMs;
  await assert.rejects(store.verify(input, true), code('CHALLENGE_EXPIRED'));
  const next = reservation({ flowKey: input.flowKey });
  await store.reserve(next); await store.activate(next, 'next-response');
  await assert.rejects(store.verify(input, true), code('CHALLENGE_UNAVAILABLE'));
  assert.deepEqual(await store.verify(next, true), { status: 'verified' });
});

test('idempotent reservation has one owner; changed payload conflicts and pending is not retried', async () => {
  const store = new DemoBankStateStore(); const input = reservation();
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => store.reserve(input)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(store.reserve({ ...input, fingerprint: randomUUID() }), code('CONFLICT'));
  await assert.rejects(store.reserve(input), code('START_PENDING'));
  await store.activate(input, 'encrypted-response');
  assert.deepEqual(await store.reserve(input), { status: 'cached', response: 'encrypted-response' });
});

test('flow, account and wallet budgets remain bounded across new request IDs', async () => {
  for (const [field, limit] of [['flowKey', BANK_LIMITS.flowStarts], ['accountKey', BANK_LIMITS.accountStarts], ['walletKey', BANK_LIMITS.walletStarts]] as const) {
    const store = new DemoBankStateStore(); const fixed = randomUUID();
    for (let i = 0; i < limit; i++) await store.reserve(reservation({ [field]: fixed }));
    await assert.rejects(store.reserve(reservation({ [field]: fixed })), code('START_BUDGET_EXCEEDED'));
  }
});

test('Redis REST uses authenticated POST, bounded requests, no redirect/retry or local fallback', async () => {
  let calls = 0;
  const fakeFetch = (async (_url, init) => {
    calls++;
    assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer synthetic-token');
    const args = JSON.parse(String(init?.body));
    assert.equal(args[0], 'EVAL'); assert.equal(args[2], 5);
    assert.ok(args.slice(3, 8).every((key: string) => key.startsWith('{test:bank}:')));
    throw new Error('response lost after Redis applied operation');
  }) as typeof fetch;
  const store = new RedisBankStateStore('https://redis.test', 'synthetic-token', fakeFetch, 'test');
  await assert.rejects(store.reserve(reservation()), code('STATE_UNAVAILABLE'));
  assert.equal(calls, 1);
  assert.throws(() => new RedisBankStateStore('http://redis.test', 'token'), code('INVALID_STATE_CONFIG'));
});
