import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newestPerSubject } from './source-order.js';

test('roster candidate selection uses the last duplicate issuance regardless of RPC return order', () => {
  const logs = [{ subject: 'alice', blockNumber: 100, logIndex: 8, claimsRoot: 'first' },
    { subject: 'alice', blockNumber: 100, logIndex: 9, claimsRoot: 'second' },
    { subject: 'alice', blockNumber: 100, logIndex: 10, claimsRoot: 'third' }];
  for (const order of [logs, [...logs].reverse(), [logs[1], logs[0], logs[2]]]) {
    assert.equal(newestPerSubject(new Map(order.map((l, i) => [String(i), l]))).get('alice')?.claimsRoot, 'third');
  }
});

test('block-global log order breaks same-block transaction ties but cannot override a newer block', () => {
  const candidates = [{ subject: 'alice', blockNumber: 100, logIndex: 100 }, { subject: 'alice', blockNumber: 101, logIndex: 0 },
    { subject: 'bob', blockNumber: 100, logIndex: 3 }, { subject: 'bob', blockNumber: 100, logIndex: 9 }];
  const selected = newestPerSubject(new Map(candidates.map((l, i) => [String(i), l])));
  assert.equal(selected.get('alice')?.blockNumber, 101); assert.equal(selected.get('bob')?.logIndex, 9);
});
