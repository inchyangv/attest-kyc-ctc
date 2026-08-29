import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Store } from './store.js';
import { Backoff } from './retry.js';
import { computeQueryId, txIndexFromProof } from './proof.js';

function tmpStore(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-'));
  return { path: join(dir, 'worker.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('queryId matches the ASC byte for byte', () => {
  test('fixed vector matches the Solidity result', () => {
    // expected value from test/QueryId.t.sol:test_QueryIdKnownVector
    assert.equal(
      computeQueryId(1, 11597452, 7),
      '0x6ca17d0e6939c57d0d71f9b17302db50a70d50e09c6144c362cadd1850a36159',
    );
  });

  test('a different chainKey gives a different queryId', () => {
    assert.notEqual(computeQueryId(1, 100, 5), computeQueryId(3, 100, 5));
  });

  test('a different blockHeight gives a different queryId', () => {
    assert.notEqual(computeQueryId(1, 100, 5), computeQueryId(1, 101, 5));
  });
});

describe('txIndexFromProof', () => {
  test('an empty proof means index 0', () => {
    assert.equal(txIndexFromProof([]), 0n);
  });

  test('recovers the index from the isLeft bits', () => {
    // siblings[0] is the least significant bit
    assert.equal(txIndexFromProof([{ isLeft: true }]), 1n);
    assert.equal(txIndexFromProof([{ isLeft: false }, { isLeft: true }]), 2n);
    assert.equal(txIndexFromProof([{ isLeft: true }, { isLeft: true }]), 3n);
  });
});

describe('Store persistence', () => {
  test('cursor and jobs survive a restart', () => {
    const { path, cleanup } = tmpStore();
    try {
      const a = new Store(path);
      a.setCursor(1000);
      a.add({ txHash: '0xaa', blockNumber: 900, action: 0, eventName: 'MarkIssued',
              logCount: 2, state: 'discovered', attempts: 0 });

      // pretend the process died and read with a fresh instance
      const b = new Store(path);
      assert.equal(b.cursor, 1000);
      assert.equal(b.get('0xaa')?.eventName, 'MarkIssued');
      assert.equal(b.get('0xaa')?.logCount, 2);
      assert.equal(b.pending().length, 1);
    } finally { cleanup(); }
  });

  test('the cursor never moves backwards', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      s.setCursor(500);
      s.setCursor(400);   // attempt to rewind
      assert.equal(s.cursor, 500);
    } finally { cleanup(); }
  });

  test('done, dead and skipped drop out of pending', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      for (const [h, st] of [['0x1', 'discovered'], ['0x2', 'done'], ['0x3', 'dead'], ['0x4', 'skipped']] as const) {
        s.add({ txHash: h, blockNumber: 1, action: 0, eventName: 'MarkIssued',
                logCount: 1, state: st, attempts: 0 });
      }
      assert.equal(s.pending().length, 1);
      assert.equal(s.pending()[0].txHash, '0x1');
    } finally { cleanup(); }
  });

  test('writes are atomic and leave no tmp file behind', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      s.setCursor(1);
      assert.ok(existsSync(path));
      assert.ok(!existsSync(`${path}.tmp`), 'a leftover tmp file means the write was not atomic');
      JSON.parse(readFileSync(path, 'utf8'));   // must always parse
    } finally { cleanup(); }
  });

  test('state transitions persist', () => {
    const { path, cleanup } = tmpStore();
    try {
      const s = new Store(path);
      s.add({ txHash: '0xbb', blockNumber: 5, action: 1, eventName: 'MarkRevoked',
              logCount: 1, state: 'discovered', attempts: 0 });
      s.update('0xbb', { state: 'submitted', ascTxHash: '0xcc' });

      const reopened = new Store(path);
      assert.equal(reopened.get('0xbb')?.state, 'submitted');
      assert.equal(reopened.get('0xbb')?.ascTxHash, '0xcc');
    } finally { cleanup(); }
  });
});

describe('Backoff', () => {
  test('grows exponentially and stays under the ceiling', () => {
    const b = new Backoff(1000, 10_000, 2);
    for (let i = 0; i < 12; i++) {
      const d = b.delayFor(i);
      assert.ok(d > 0, 'must be positive');
      assert.ok(d <= 10_000, `above ceiling: ${d}`);
    }
    // jitter is in play, so sample a few and compare averages
    const avg = (n: number) => Array.from({ length: 50 }, () => b.delayFor(n)).reduce((a, c) => a + c) / 50;
    assert.ok(avg(3) > avg(0), 'more attempts should mean a longer wait');
  });
});
