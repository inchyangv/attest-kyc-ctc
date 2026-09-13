import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import { Store, type Job, type WorkerScope } from './store.js';
import { monitorWorker, readWorkerMonitorState, WORKER_MONITOR_MAX_BYTES } from './monitor.js';

const scope: WorkerScope = { sourceChainId: 11155111, hubChainId: 102031, chainKey: 1, startBlock: 10,
  source: '0x' + '11'.repeat(20), asc: '0x' + '22'.repeat(20), signer: '0x' + '33'.repeat(20) };
const limits = { jobAgeMs: 1000, attempts: 3 };
const job = (id: string, state: Job['state'] = 'discovered'): Job => ({ txHash: ethers.id(id), blockNumber: 10,
  blockHash: ethers.id('block'), transactionIndex: 0, action: 0, eventName: 'MarkIssued', logCount: 1, state,
  attempts: 0, discoveredAt: 0, updatedAt: 0 });
const state = (...jobs: Job[]) => ({ version: 1, scope, cursor: 10, jobs: Object.fromEntries(jobs.map(j => [j.txHash, j])),
  hubStartNonce: 0, sourceCheckpoints: [{ height: 9, hash: ethers.id('anchor') }, { height: 10, hash: ethers.id('block') }] });

test('legacy skipped jobs remain visible and malformed stored skip observations are unavailable', () => {
  const skipped = job('legacy', 'skipped');
  assert.equal(monitorWorker(state(skipped), scope, limits, 1000).counts.SKIP_WITHOUT_CONFIRMED_OBSERVATION, 1);
  const skipObservation = { blockNumber: 1, blockHash: ethers.id('hub'), confirmations: 2, observedAt: 0 };
  assert.equal(monitorWorker(state({ ...skipped, skipObservation }), scope, limits, 1000).status, 'NO_LOCAL_FINDINGS');
  for (const change of [{ confirmations: 0 }, { observedAt: 1001 }, { blockHash: 'invalid' }, { blockNumber: NaN }]) {
    assert.throws(() => monitorWorker(state({ ...skipped, skipObservation: { ...skipObservation, ...change } }), scope, limits, 1000));
  }
});

test('worker deadlines use discovery age, inclusive thresholds and distinct pending/dead/terminal states', () => {
  const pending = { ...job('pending'), attempts: 3, updatedAt: 999, lastError: 'PRIVATE-RPC-ERROR' };
  const report = monitorWorker(state(pending, job('dead', 'dead'), job('done', 'done'), job('skipped', 'skipped')), scope, limits, 1000);
  assert.equal(report.counts.JOB_OVERDUE, 1); assert.equal(report.counts.RETRY_THRESHOLD_REACHED, 1);
  assert.equal(report.counts.PENDING_JOB_ERROR, 1); assert.equal(report.counts.DEAD_LETTER, 1);
  assert.equal(report.oldestPendingAgeMs, 1000); assert.equal(report.totalJobs, 4);
  assert.equal(report.processLiveness, 'NOT_CHECKED'); assert.equal(report.chainState, 'NOT_CHECKED');
  assert.equal(JSON.stringify(report).includes('PRIVATE-'), false);
  assert.equal(monitorWorker(state(job('young')), scope, limits, 999).status, 'NO_LOCAL_FINDINGS');
});

test('retained state metrics separate completed, skipped and failed latency with retry distribution', () => {
  const report = monitorWorker(state(
    { ...job('done-a', 'done'), attempts: 1, updatedAt: 10 },
    { ...job('done-b', 'done'), attempts: 2, updatedAt: 100 },
    { ...job('skipped', 'skipped'), attempts: 0, updatedAt: 20,
      skipObservation: { blockNumber: 1, blockHash: ethers.id('hub'), confirmations: 2, observedAt: 10 } },
    { ...job('failed', 'dead'), attempts: 3, updatedAt: 50 }), scope, limits, 100);
  assert.deepEqual(report.retainedStateMetrics.completedLatencyMs, { sampleCount: 2, p50: 10, p95: 100, p99: 100 });
  assert.deepEqual(report.retainedStateMetrics.skippedLatencyMs, { sampleCount: 1, p50: 20, p95: 20, p99: 20 });
  assert.deepEqual(report.retainedStateMetrics.failedLatencyMs, { sampleCount: 1, p50: 50, p95: 50, p99: 50 });
  assert.deepEqual(report.retainedStateMetrics.terminalOutcomes,
    { sampleCount: 4, completed: 2, skipped: 1, failed: 1, failureRatePpm: 250000 });
  assert.deepEqual(report.retainedStateMetrics.attempts,
    { sampleCount: 4, p50: 1, p95: 3, p99: 3, total: 6, retriedJobs: 3 });
  assert.deepEqual(report.retainedStateMetrics.pendingAgeMs, { sampleCount: 0, p50: null, p95: null, p99: null });
  assert.deepEqual(report.retainedStateMetrics.overduePendingAgeMs, { sampleCount: 0, p50: null, p95: null, p99: null });
  const pending = monitorWorker(state({ ...job('pending'), discoveredAt: 0, updatedAt: 0 }), scope,
    { ...limits, jobAgeMs: 50 }, 100).retainedStateMetrics;
  assert.deepEqual(pending.pendingAgeMs, { sampleCount: 1, p50: 100, p95: 100, p99: 100 });
  assert.deepEqual(pending.overduePendingAgeMs, { sampleCount: 1, p50: 100, p95: 100, p99: 100 });
});

test('source safety hold and even young unresolved relay remain visible without exposing signed data', () => {
  const submitted = { ...job('submitted', 'submitted'), ascTxHash: ethers.id('relay'), queryId: ethers.id('query') };
  const relay = { sourceTxHash: submitted.txHash, hash: submitted.ascTxHash, queryId: submitted.queryId, nonce: 0,
    chainId: scope.hubChainId, to: scope.asc, signer: scope.signer, raw: 'PRIVATE-SIGNED-BYTES', data: 'PRIVATE-PROOF' };
  const input = { ...state(submitted), relay, sourceHold: 'PRIVATE-SAFETY-REASON' };
  const report = monitorWorker(input, scope, limits, 1);
  assert.equal(report.counts.SOURCE_SAFETY_HOLD, 1); assert.equal(report.counts.RELAY_NONCE_UNRESOLVED, 1);
  assert.equal(report.counts.SUBMITTED_WITHOUT_RELAY_ENVELOPE, undefined);
  assert.equal(JSON.stringify(report).includes('PRIVATE-'), false);
  assert.equal(monitorWorker(state(submitted), scope, limits, 1).counts.SUBMITTED_WITHOUT_RELAY_ENVELOPE, 1);
  const hubHeld = monitorWorker({ ...state(job('hub')), hubHold: 'PRIVATE-HUB-REASON' }, scope, limits, 1);
  assert.equal(hubHeld.counts.HUB_SAFETY_HOLD, 1); assert.equal(JSON.stringify(hubHeld).includes('PRIVATE-'), false);
  for (const change of [{ chainId: 1 }, { sourceTxHash: ethers.id('missing') }, { hash: ethers.id('other') }, { signer: scope.source }]) {
    assert.throws(() => monitorWorker({ ...input, relay: { ...relay, ...change } }, scope, limits, 1));
  }
});

test('invalid scope, uninitialized checkpoints, coordinates, clocks and configuration cannot look quiet', () => {
  const input = state(job('pending'));
  for (const change of [{ version: 2 }, { scope: { ...scope, chainKey: 2 } }, { scope: undefined }, { sourceCheckpoints: [] },
    { sourceCheckpoints: [{ height: 10, hash: ethers.id('block') }] }, { cursor: 11 }, { relay: null }, { jobs: [] },
    { sourceCheckpoints: [{ height: 9, hash: ethers.id('anchor') }, { height: 9, hash: ethers.id('block') }] }]) {
    assert.throws(() => monitorWorker({ ...input, ...change }, scope, limits, 1000));
  }
  for (const change of [{ blockHash: undefined }, { blockNumber: 11 }, { transactionIndex: -1 }, { updatedAt: 1001 },
    { discoveredAt: 1001 }, { state: 'unknown' }, { action: 6 }, { logCount: 0 }, { lastError: {} }]) {
    assert.throws(() => monitorWorker(state({ ...job('pending'), ...change } as Job), scope, limits, 1000));
  }
  for (const jobAgeMs of [0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => monitorWorker(input, scope, { ...limits, jobAgeMs }, 1000));
  }
});

test('worker report bounds details while preserving all counts and withholding identifiers', () => {
  const jobs = Array.from({ length: 150 }, (_, i) => job(`PRIVATE-${i}`, 'dead'));
  const report = monitorWorker(state(...jobs), scope, Object.assign({ ...limits }, { secret: 'PRIVATE-SETTING' }), 1000);
  assert.equal(report.findingCount, 150); assert.equal(report.counts.DEAD_LETTER, 150);
  assert.equal(report.findings.length, 100); assert.equal(report.findingsTruncated, true);
  for (const secret of ['PRIVATE-', jobs[0].txHash, scope.signer]) assert.equal(JSON.stringify(report).includes(secret), false);
});

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-worker-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'worker.json'), store = new Store(path);
  store.bindScope(scope); store.initializeHubSigner(0); store.initializeSource({ height: 9, hash: ethers.id('anchor') });
  store.commitSourceRange(10, { height: 10, hash: ethers.id('block') }, [job('actual')]);
  return { dir, path, store };
}

test('real Store lifecycle is inspected without writes, locks or missing-directory creation', t => {
  const f = fixture(t), bytes = readFileSync(f.path);
  const first = monitorWorker(readWorkerMonitorState(f.path), scope, { ...limits, jobAgeMs: 60000 });
  assert.equal(first.status, 'NO_LOCAL_FINDINGS'); assert.deepEqual(readFileSync(f.path), bytes);
  f.store.reserveRelay({ sourceTxHash: ethers.id('actual'), hash: ethers.id('signed'), queryId: ethers.id('query'),
    nonce: 0, chainId: scope.hubChainId, to: scope.asc, signer: scope.signer, raw: 'PRIVATE-RAW', data: 'PRIVATE-DATA' });
  assert.equal(monitorWorker(readWorkerMonitorState(f.path), scope, limits).counts.RELAY_NONCE_UNRESOLVED, 1);
  f.store.finishRelay(ethers.id('signed'), { status: 'success', blockNumber: 5, blockHash: ethers.id('hub') });
  assert.equal(monitorWorker(readWorkerMonitorState(f.path), scope, limits).status, 'NO_LOCAL_FINDINGS');
  assert.throws(() => f.store.holdSource('PRIVATE-HOLD'));
  assert.equal(monitorWorker(readWorkerMonitorState(f.path), scope, limits).counts.SOURCE_SAFETY_HOLD, 1);
  const missing = join(f.dir, 'absent', 'worker.json'); assert.throws(() => readWorkerMonitorState(missing));
  assert.equal(existsSync(join(f.dir, 'absent')), false);
});

test('file reader rejects oversized, nonregular, malformed JSON and invalid UTF-8 state', t => {
  const f = fixture(t);
  assert.throws(() => readWorkerMonitorState(f.dir));
  for (const bytes of [Buffer.from('{'), Buffer.from([0x22, 0xff, 0x22])]) {
    writeFileSync(f.path, bytes); assert.throws(() => readWorkerMonitorState(f.path));
  }
  truncateSync(f.path, WORKER_MONITOR_MAX_BYTES + 1); assert.throws(() => readWorkerMonitorState(f.path));
});

test('actual CLI distinguishes quiet/findings/unavailable with explicit non-secret scope and no mutation', t => {
  const f = fixture(t), env = { PATH: process.env.PATH, WORKER_STATE_PATH: f.path, SOURCE_CHAIN_ID: String(scope.sourceChainId),
    MONITOR_WORKER_HUB_CHAIN_ID: String(scope.hubChainId), SOURCE_CHAIN_KEY: String(scope.chainKey), WORKER_START_BLOCK: String(scope.startBlock),
    SOURCE_CONTRACT_ADDRESS: scope.source, ASC_CONTRACT_ADDRESS: scope.asc, MONITOR_WORKER_SIGNER_ADDRESS: scope.signer,
    MONITOR_WORKER_JOB_SECONDS: '600', MONITOR_WORKER_ATTEMPTS: '3' };
  const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'script/monitor-worker.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { ...env, ...extra } });
  const bytes = readFileSync(f.path), quiet = run(); assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(JSON.parse(quiet.stdout).processLiveness, 'NOT_CHECKED'); assert.deepEqual(readFileSync(f.path), bytes);
  f.store.update(ethers.id('actual'), { state: 'dead', lastError: 'PRIVATE-RPC-ERROR' });
  const deadBytes = readFileSync(f.path), flagged = run(); assert.equal(flagged.status, 1);
  assert.equal(JSON.parse(flagged.stdout).counts.DEAD_LETTER, 1); assert.equal(flagged.stdout.includes('PRIVATE-'), false);
  const invalidSettings: Record<string, string>[] = [{ MONITOR_WORKER_ATTEMPTS: '' }, { MONITOR_WORKER_HUB_CHAIN_ID: '1' },
    { WORKER_STATE_PATH: join(f.dir, 'absent', 'PRIVATE-worker.json') }];
  for (const extra of invalidSettings) {
    const result = run(extra); assert.equal(result.status, 2); assert.equal(result.stdout, '');
    assert.equal(result.stderr.trim(), 'WORKER_MONITOR_UNAVAILABLE');
  }
  assert.equal(existsSync(join(f.dir, 'absent')), false); assert.deepEqual(readFileSync(f.path), deadBytes);
});
