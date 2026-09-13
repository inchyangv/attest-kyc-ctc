import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoundedPool } from './pool.js';
import { Store, jobsReadyForDispatch } from './store.js';
import { integerSetting } from './settings.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('PM-T15-01: RPC-delayed capacity plus repeated scans creates no duplicate execution or memory waiters', async () => {
  const gate = deferred(); const errors: unknown[] = [];
  const pool = new BoundedPool(3, error => errors.push(error));
  const counts = new Map<string, number>(); let accepted = 0; let active = 0; let peak = 0;
  try {
    for (let scan = 0; scan < 100; scan++) {
      for (let j = 0; j < 1000; j++) {
        const id = String(j);
        if (pool.tryRun(id, async () => {
          counts.set(id, (counts.get(id) ?? 0) + 1); active++; peak = Math.max(peak, active);
          await gate.promise; active--;
        })) accepted++;
      }
      assert.equal(pool.waiting, 0, `scan ${scan} must leave overflow only in the durable backlog`);
    }
    assert.equal(accepted, 3); assert.equal(pool.size, 3); assert.equal(pool.available, 0);
    await setImmediate();
    assert.equal(peak, 3); assert.deepEqual([...counts.values()], [1, 1, 1]); assert.equal(pool.waiting, 0);
  } finally { gate.resolve(); await pool.drain(); }
  assert.equal(pool.size, 0); assert.equal(pool.waiting, 0); assert.equal(active, 0); assert.deepEqual(errors, []);
});

test('durable backlog exceeds capacity without loss; every job executes once across polling cycles', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-pool-'));
  const store = new Store(join(dir, 'worker.json')); const pool = new BoundedPool(3, error => { throw error; });
  const executed = new Map<string, number>();
  try {
    for (let i = 0; i < 120; i++) store.add({ txHash: `0x${i}`, blockNumber: 100, action: 0, eventName: 'MarkIssued', logCount: 1, state: 'discovered', attempts: 0 });
    for (let cycle = 0; cycle < 100 && store.pending().length; cycle++) {
      for (const job of jobsReadyForDispatch(store, pool, pool.available)) {
        pool.tryRun(job.txHash, async () => {
          executed.set(job.txHash, (executed.get(job.txHash) ?? 0) + 1);
          await setImmediate(); store.update(job.txHash, { state: 'done' });
        });
      }
      assert.ok(pool.size <= 3); assert.equal(pool.waiting, 0);
      await setImmediate(); await setImmediate();
    }
    await pool.drain();
    assert.equal(executed.size, 120); assert.ok([...executed.values()].every(n => n === 1));
    assert.equal(new Store(join(dir, 'worker.json')).pending().length, 0);
  } finally { await pool.drain(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed jobs release reservations and can be retried without leaking rejected promises', async () => {
  const errors: unknown[] = []; const pool = new BoundedPool(1, error => { errors.push(error); throw new Error('reporter also failed'); });
  assert.equal(pool.tryRun('a', async () => { throw new Error('RPC failure'); }), true);
  assert.equal(pool.tryRun('a', async () => {}), false);
  await setImmediate(); assert.equal(pool.size, 0); assert.equal(errors.length, 1);
  let retry = 0;
  assert.equal(pool.tryRun('a', async () => { retry++; }), true);
  await setImmediate(); assert.equal(retry, 1); assert.equal(pool.size, 0);
  await pool.drain();
});

test('stop refuses new reservations and drain waits only for genuinely running jobs', async () => {
  const gate = deferred(); const pool = new BoundedPool(1, () => {}); let drained = false;
  pool.tryRun('running', () => gate.promise);
  assert.equal(pool.tryRun('waiting', async () => { throw new Error('must never execute'); }), false);
  const drain = pool.drain().then(() => { drained = true; });
  await setImmediate(); assert.equal(drained, false); assert.equal(pool.available, 0);
  assert.equal(pool.tryRun('new', async () => {}), false);
  gate.resolve(); await drain; assert.equal(drained, true); assert.equal(pool.size, 0);
});

test('worker integer settings reject zero concurrency, negatives, fractions and unsafe ranges', () => {
  assert.equal(integerSetting('concurrency', undefined, 8, 1), 8);
  assert.equal(integerSetting('startBlock', '0', 0), 0);
  assert.throws(() => integerSetting('WORKER_START_BLOCK', '0', 0, 1), /safe integer/);
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    assert.throws(() => integerSetting('concurrency', value, 8, 1), /safe integer/);
  }
  for (const capacity of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => new BoundedPool(capacity, () => {}), /positive safe integer/);
});
