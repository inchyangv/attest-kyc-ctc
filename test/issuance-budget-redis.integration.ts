import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { RedisIssuanceBudget, IssuanceBudgetError } from '../pipeline/issuance-budget.js';

const exec = promisify(execFile);
const container = process.env.TEST_REDIS_CONTAINER;
if (!container || !/^proofmark-bank-test-[a-zA-Z0-9-]+$/.test(container)) throw new Error('Use npm run test:issuance-budget.');
const namespace = `budget-${randomUUID()}`;
const bridge = (async (_url, init) => {
  const args = JSON.parse(String(init?.body)) as (string | number)[];
  const { stdout } = await exec('docker', ['exec', container, 'redis-cli', '--json', ...args.map(String)], { maxBuffer: 2_000_000 });
  return Response.json({ result: JSON.parse(stdout) });
}) as typeof fetch;
const budget = (request = bridge) => new RedisIssuanceBudget({
  url: 'https://synthetic-budget.test', token: 'synthetic-token',
  secret: 'synthetic-budget-key-at-least-32-characters', namespace,
  dailyGasLimit: 100_000n, dailyTransactionLimit: 2,
}, request);

test('PM-T22-01 independent instances share one issuer gas ceiling and preserve uncertain reservations', async () => {
  const issuer = '0x' + '11'.repeat(20), a = '0x' + 'aa'.repeat(32), b = '0x' + 'bb'.repeat(32);
  const first = budget(), second = budget();
  assert.deepEqual(await first.reserve({ requestId: a, issuer, gasLimit: 60_000n }), { reservedGas: 60_000n, transactionCount: 1 });
  await assert.rejects(second.reserve({ requestId: b, issuer, gasLimit: 60_000n }),
    (error: unknown) => error instanceof IssuanceBudgetError && error.code === 'DAILY_GAS_BUDGET_EXCEEDED');
  // An unknown broadcast outcome stays charged; restarting another instance does not create room.
  assert.deepEqual(await budget().reserve({ requestId: a, issuer, gasLimit: 60_000n }), { reservedGas: 60_000n, transactionCount: 1 });
  await first.reconcile({ requestId: a, issuer, gasUsed: 40_000n });
  assert.deepEqual(await second.reserve({ requestId: b, issuer, gasLimit: 60_000n }), { reservedGas: 100_000n, transactionCount: 2 });
  await second.reconcile({ requestId: b, issuer, gasUsed: 50_000n });
  assert.deepEqual(await first.status(issuer), { reservedGas: 90_000n, transactionCount: 2 });
});

test('lost reserve/reconcile replies are idempotent and changed request facts fail closed', async () => {
  const issuer = '0x' + '22'.repeat(20), requestId = '0x' + 'cc'.repeat(32);
  let dropReserve = true, dropReconcile = true;
  const lossy = (async (url, init) => {
    const response = await bridge(url, init);
    const args = JSON.parse(String(init?.body)) as (string | number)[];
    if (args[3 + Number(args[2])] === 'reserve' && dropReserve) { dropReserve = false; throw new Error('synthetic committed reserve response loss'); }
    if (args[3 + Number(args[2])] === 'reconcile' && dropReconcile) { dropReconcile = false; throw new Error('synthetic committed reconcile response loss'); }
    return response;
  }) as typeof fetch;
  await assert.rejects(budget(lossy).reserve({ requestId, issuer, gasLimit: 70_000n }), /BUDGET_UNAVAILABLE/);
  assert.deepEqual(await budget().reserve({ requestId, issuer, gasLimit: 70_000n }), { reservedGas: 70_000n, transactionCount: 1 });
  await assert.rejects(budget(lossy).reconcile({ requestId, issuer, gasUsed: 50_000n }), /BUDGET_UNAVAILABLE/);
  await budget().reconcile({ requestId, issuer, gasUsed: 50_000n });
  assert.deepEqual(await budget().status(issuer), { reservedGas: 50_000n, transactionCount: 1 });
  await assert.rejects(budget().reserve({ requestId, issuer, gasLimit: 60_000n }), /BUDGET_REQUEST_CONFLICT/);
  await assert.rejects(budget().reconcile({ requestId, issuer: '0x' + '33'.repeat(20), gasUsed: 50_000n }), /BUDGET_REQUEST_CONFLICT/);
});

test('transaction ceiling and impossible receipt usage fail without changing the ledger', async () => {
  const issuer = '0x' + '44'.repeat(20), ids = ['dd', 'ee', 'ff'].map(byte => '0x' + byte.repeat(32));
  await budget().reserve({ requestId: ids[0], issuer, gasLimit: 10_000n });
  await budget().reserve({ requestId: ids[1], issuer, gasLimit: 10_000n });
  await assert.rejects(budget().reserve({ requestId: ids[2], issuer, gasLimit: 1n }), /DAILY_TRANSACTION_BUDGET_EXCEEDED/);
  await assert.rejects(budget().reconcile({ requestId: ids[0], issuer, gasUsed: 10_001n }), /BUDGET_ACTUAL_EXCEEDS_RESERVATION/);
  assert.deepEqual(await budget().status(issuer), { reservedGas: 20_000n, transactionCount: 2 });
});
