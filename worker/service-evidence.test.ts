import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditWorkerServiceEvidence, readWorkerServiceEvidence, recordWorkerServiceEvidence,
  serviceEvidenceAuditSettings } from './service-evidence.js';
import type { WorkerServiceMonitorResult } from './service-monitor.js';
import { workerServiceDeploymentDigest, workerServiceMonitorSettings } from './service-monitor.js';

const DAY = 24 * 60 * 60 * 1000;
const deploymentDigest = 'a'.repeat(64);
const report = (observedAt: number, status: WorkerServiceMonitorResult['status'] = 'SERVICE_OBSERVATIONS_OK', elapsedMs = 10,
  totalJobs = 10, digest = deploymentDigest): WorkerServiceMonitorResult => ({ version: 1, scope: 'independent-worker-service-monitor', status,
  code: status === 'SERVICE_OBSERVATIONS_OK' ? 'OBSERVATIONS_WITHIN_THRESHOLDS' : status === 'ATTENTION_REQUIRED' ? 'THRESHOLD_FINDINGS' : 'OBSERVATION_UNAVAILABLE',
  deploymentDigest: digest, observedAt, elapsedMs, processIdentity: 'NOT_VERIFIED',
  chainState: status === 'UNAVAILABLE' ? 'NOT_CHECKED' : 'OBSERVED_FROM_CONFIGURED_RPC_NOT_INDEPENDENTLY_VERIFIED', alertDelivery: 'NOT_CHECKED',
  ...(status === 'UNAVAILABLE' ? {} : { state: { totalJobs, retainedStateMetrics: { marker: 'latest' } } as never }) });

function directory(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), 'proofmark-worker-service-evidence-'));
  t.after(() => rmSync(path, { recursive: true, force: true })); return path;
}

test('atomic evidence records are digest-bound, deployment-bound and preserve redacted reports', t => {
  const dir = directory(t), now = Date.now(), original = report(now);
  const path = recordWorkerServiceEvidence(dir, original, now + 1);
  assert.equal(readWorkerServiceEvidence(dir, deploymentDigest)[0].status, 'SERVICE_OBSERVATIONS_OK');
  assert.equal((readFileSync(path, 'utf8').match(/PRIVATE/g) ?? []).length, 0);
  const envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.report.code = 'PRIVATE';
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => readWorkerServiceEvidence(dir, deploymentDigest), /^Error: WORKER_SERVICE_EVIDENCE_INVALID$/);
  assert.throws(() => readWorkerServiceEvidence(dir, 'b'.repeat(64)));
  assert.throws(() => recordWorkerServiceEvidence(directory(t), { ...original, findings: ['X'.repeat(300_000)] }, now + 1));
  const unexpected = directory(t); writeFileSync(join(unexpected, 'ignored.json'), '{}');
  assert.throws(() => readWorkerServiceEvidence(unexpected, deploymentDigest));
});

test('seven-day audit reports sample counts and p50/p95/p99 for ok, attention and unavailable runs', t => {
  const dir = directory(t), now = Date.now();
  for (let day = 7; day >= 0; day--) {
    const status = day === 4 ? 'ATTENTION_REQUIRED' : day === 2 ? 'UNAVAILABLE' : 'SERVICE_OBSERVATIONS_OK';
    const observedAt = now - day * DAY;
    recordWorkerServiceEvidence(dir, report(observedAt, status, 10 + day, 20), now);
  }
  const audit = auditWorkerServiceEvidence(readWorkerServiceEvidence(dir, deploymentDigest), deploymentDigest,
    { maxRunGapMs: DAY + 1, requiredWindowMs: 7 * DAY, targetMinJobs: 20 }, now);
  assert.equal(audit.sampleCount, 8); assert.deepEqual(audit.statusCounts,
    { SERVICE_OBSERVATIONS_OK: 6, ATTENTION_REQUIRED: 1, UNAVAILABLE: 1 });
  assert.equal(audit.probeLatencyMs.ok.sampleCount, 6);
  assert.deepEqual(audit.findings, ['ATTENTION_SAMPLES_PRESENT', 'UNAVAILABLE_SAMPLES_PRESENT']);
  assert.deepEqual(audit.latestRetainedStateMetrics, { marker: 'latest' });
  assert.equal(audit.alertDelivery, 'NOT_CHECKED'); assert.equal(audit.schedulerInstallation, 'NOT_CHECKED');
});

test('never-run, missed-run, historical gap, incomplete window and missing target load stay explicit', () => {
  const now = Date.now(), settings = { maxRunGapMs: 1000, requiredWindowMs: 5000, targetMinJobs: 100 };
  const empty = auditWorkerServiceEvidence([], deploymentDigest, settings, now);
  assert.deepEqual(empty.findings, ['PROBE_NEVER_RECORDED', 'STAGING_WINDOW_INCOMPLETE', 'TARGET_LOAD_NOT_OBSERVED']);
  const sparse = auditWorkerServiceEvidence([report(now - 6000), report(now - 4000), report(now - 2000)], deploymentDigest, settings, now);
  assert.deepEqual(sparse.findings, ['PROBE_RUN_MISSED', 'PROBE_RUN_GAP', 'TARGET_LOAD_NOT_OBSERVED']);
});

test('production settings cannot shrink the staging window below seven days or hide missed schedules', () => {
  const valid = { MONITOR_WORKER_RUN_INTERVAL_SECONDS: '60', MONITOR_WORKER_MISSED_AFTER_SECONDS: '121',
    MONITOR_WORKER_STAGING_SECONDS: '604800', MONITOR_WORKER_STAGING_MIN_JOBS: '0' };
  assert.deepEqual(serviceEvidenceAuditSettings(valid),
    { maxRunGapMs: 121000, requiredWindowMs: 604800000, targetMinJobs: 0 });
  for (const change of [{ MONITOR_WORKER_STAGING_SECONDS: '604799' }, { MONITOR_WORKER_MISSED_AFTER_SECONDS: '60' },
    { MONITOR_WORKER_RUN_INTERVAL_SECONDS: '0' }, { MONITOR_WORKER_STAGING_MIN_JOBS: '-1' }]) {
    assert.throws(() => serviceEvidenceAuditSettings({ ...valid, ...change }), /^Error: WORKER_SERVICE_EVIDENCE_SETTINGS_INVALID$/);
  }
});

test('actual evidence audit CLI returns attention, complete and unavailable without probing RPC', t => {
  const dir = directory(t), now = Date.now();
  const env = { PATH: process.env.PATH, SOURCE_CHAIN_RPC_URL: 'http://127.0.0.1:1', CREDITCOIN_RPC_URL: 'http://127.0.0.1:2',
    WORKER_HEALTH_PORT: '9001', MONITOR_WORKER_SERVICE_TIMEOUT_MS: '1000', WORKER_HEALTH_MAX_SCAN_AGE_MS: '10000',
    WORKER_STATE_PATH: '/tmp/not-read-by-audit', SOURCE_CHAIN_ID: '11155111', MONITOR_WORKER_HUB_CHAIN_ID: '102031', SOURCE_CHAIN_KEY: '1',
    WORKER_START_BLOCK: '10', SOURCE_CONTRACT_ADDRESS: '0x' + '11'.repeat(20), ASC_CONTRACT_ADDRESS: '0x' + '22'.repeat(20),
    MONITOR_WORKER_SIGNER_ADDRESS: '0x' + '33'.repeat(20), MONITOR_WORKER_JOB_SECONDS: '60', MONITOR_WORKER_ATTEMPTS: '3',
    MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: '5', MONITOR_WORKER_SOURCE_MAX_HEAD_AGE_SECONDS: '30', MONITOR_WORKER_HUB_MAX_HEAD_AGE_SECONDS: '30',
    MONITOR_WORKER_HUB_MIN_BALANCE_WEI: '0', MONITOR_WORKER_HUB_MAX_GAS_PRICE_WEI: '100', MONITOR_WORKER_HUB_MAX_NONCE_BACKLOG: '2',
    MONITOR_WORKER_EVIDENCE_DIR: dir, MONITOR_WORKER_RUN_INTERVAL_SECONDS: '86400', MONITOR_WORKER_MISSED_AFTER_SECONDS: '86401',
    MONITOR_WORKER_STAGING_SECONDS: '604800', MONITOR_WORKER_STAGING_MIN_JOBS: '0' };
  const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'script/audit-worker-service.ts'],
    { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(run().status, 1);
  const exactDigest = workerServiceDeploymentDigest(workerServiceMonitorSettings(env));
  for (let day = 7; day >= 0; day--) recordWorkerServiceEvidence(dir, report(now - day * DAY, 'SERVICE_OBSERVATIONS_OK', 10, 10, exactDigest), now);
  const complete = run(); assert.equal(complete.status, 0, complete.stderr);
  assert.equal(JSON.parse(complete.stdout).status, 'STAGING_WINDOW_COMPLETE');
  const path = join(dir, readdirSync(dir).find(name => name.endsWith('.json'))!); writeFileSync(path, '{}');
  const invalid = run(); assert.equal(invalid.status, 2); assert.equal(invalid.stderr.trim(), 'WORKER_SERVICE_EVIDENCE_UNAVAILABLE');
});
