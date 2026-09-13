import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardRequest, MAX_LOCAL_BUCKETS, RequestGuardError } from '../lib/request-guard';

test('local counter capacity is bounded, preserves active quotas, and expires each bucket using its own window', t => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const req = (client: string) => new Request('http://localhost/test', { headers: { 'x-forwarded-for': client } });
  const short = { bucket: 'short', limit: 1, windowMs: 60_000 };
  const long = { bucket: 'long', limit: 1, windowMs: 3_600_000 };
  guardRequest(req('long-lived'), long);
  for (let i = 1; i < MAX_LOCAL_BUCKETS; i++) guardRequest(req(`synthetic-${i}`), short);
  assert.throws(() => guardRequest(req('overflow'), short), e => e instanceof RequestGuardError && e.status === 429 && e.message.includes('capacity'));
  assert.throws(() => guardRequest(req('synthetic-1'), short), /rate limit exceeded/);
  now += 60_001;
  guardRequest(req('overflow'), short);
  // A short-window caller may not flush the hour-long issuer quota.
  assert.throws(() => guardRequest(req('long-lived'), long), e => e instanceof RequestGuardError && e.status === 429 && (e.retryAfter ?? 0) > 3000);
  now += 3_600_000;
  guardRequest(req('long-lived'), long);
});
