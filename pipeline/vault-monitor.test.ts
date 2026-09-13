import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { monitorVault, type VaultMonitorSnapshot, type VaultMonitorLimits } from './vault-monitor.js';
import { EvidenceVault } from './vault.js';

const limits: VaultMonitorLimits = { screeningIntervalMs: 1000, pendingIssuanceMs: 1000, reviewRecordAgeMs: 1000, revocationMs: 1000, observationMaxAgeMs: 1000 };
const record = (id: string, state: VaultMonitorSnapshot['records'][number]['state'] = 'active') => ({ id, state, createdAt: 0,
  retentionUntil: 20000, lastScreenedAt: 0, sourceObserved: false });

test('local lifecycle findings distinguish unsigned/source-observed pending, review age, screening and uncovered BLOCK', () => {
  const snapshot: VaultMonitorSnapshot = { records: [record('active'), record('unsigned', 'pending'),
    { ...record('source', 'pending'), sourceObserved: true }, record('review', 'review'), record('blocked', 'blocked')], revocations: [] };
  const report = monitorVault(snapshot, limits, 1000);
  assert.equal(report.counts.SCREENING_DUE, 3);
  assert.equal(report.counts.ISSUANCE_UNRECONCILED, 1);
  assert.equal(report.counts.HUB_MATERIALIZATION_PENDING, 1);
  assert.equal(report.counts.REVIEW_RECORD_AGE, 1);
  assert.equal(report.counts.BLOCK_WITHOUT_REVOCATION, 1);
  assert.equal(report.currentEnforcement, 'NOT_CHECKED'); assert.equal(report.processLiveness, 'NOT_CHECKED');
  const early = monitorVault({ records: [record('active')], revocations: [] }, limits, 999);
  assert.equal(early.status, 'NO_LOCAL_FINDINGS'); assert.equal(early.currentEnforcement, 'NOT_CHECKED');
});

test('retention exclusions, pending revocation errors and stale historical positives stay visible', () => {
  const snapshot: VaultMonitorSnapshot = { records: [{ ...record('expired'), retentionUntil: 1000 }],
    revocations: [{ id: 'pending', recordId: 'r', state: 'prepared', createdAt: 0, hasError: true },
      { id: 'missing', recordId: 'r', state: 'confirmed', createdAt: 0, confirmedAt: 1000, hasError: false },
      { id: 'stale', recordId: 'r', state: 'confirmed', createdAt: 0, confirmedAt: 1000, hasError: false, latestObservation: { state: 'ENFORCED', observedAt: 1 } },
      { id: 'negative', recordId: 'r', state: 'confirmed', createdAt: 0, confirmedAt: 1000, hasError: false, latestObservation: { state: 'SUPERSEDED', observedAt: 2 } }] };
  const result = monitorVault(snapshot, limits, 2000);
  assert.equal(result.counts.RETAINED_RECORD_OUTSIDE_SCREENING, 1); assert.equal(result.counts.SCREENING_DUE, undefined);
  for (const code of ['REVOCATION_OVERDUE', 'REVOCATION_ERROR', 'HUB_OBSERVATION_MISSING', 'HUB_OBSERVATION_STALE', 'LAST_OBSERVATION_SUPERSEDED']) assert.equal(result.counts[code], 1);
});

test('invalid limits, future clocks, unknown states and unconfirmed metadata cannot produce a quiet report', () => {
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => monitorVault({ records: [], revocations: [] }, { ...limits, revocationMs: value }, 1000));
  for (const value of [{ ...record('future'), createdAt: 2000 }, { ...record('future'), lastScreenedAt: 2000 },
    { ...record('bad'), state: 'invented' as 'active' }, { ...record('bad'), retentionUntil: -1 }]) {
    assert.throws(() => monitorVault({ records: [value], revocations: [] }, limits, 1000));
  }
  assert.throws(() => monitorVault({ records: [], revocations: [{ id: 'job', recordId: 'r', state: 'confirmed', createdAt: 0, hasError: false }] }, limits, 1000));
  assert.throws(() => monitorVault({ records: [], revocations: [{ id: 'job', recordId: 'r', state: 'confirmed', createdAt: 0, confirmedAt: 1,
    hasError: false, latestObservation: { state: 'ENFORCED', observedAt: 2 } }] }, limits, 1000));
});

test('output bounds retain complete finding counts without reflecting raw IDs or extra limit fields', () => {
  const records = Array.from({ length: 150 }, (_, i) => record(`PRIVATE-ID-${i}`));
  const result = monitorVault({ records, revocations: [] }, Object.assign({ ...limits }, { secret: 'PRIVATE-LIMIT' }), 1000);
  assert.equal(result.findingCount, 150); assert.equal(result.counts.SCREENING_DUE, 150);
  assert.equal(result.findings.length, 100); assert.equal(result.findingsTruncated, true);
  assert.equal(JSON.stringify(result).includes('PRIVATE-'), false);
});

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-monitor-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), key = 'synthetic-monitor-vault-key-at-least-32-characters';
  const vault = new EvidenceVault(path, key);
  vault.put({ id: 'PRIVATE-RECORD', state: 'active', walletAddress: '0x' + 'ab'.repeat(20), consentVersion: 'synthetic',
    screeningSubject: { fullName: 'PRIVATE-NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + 'ab'.repeat(20) },
    evidenceHash: 'synthetic', evidence: { private: 'PRIVATE-EVIDENCE' }, createdAt: 1, retentionUntil: 1000, lastScreenedAt: 1, reviews: [], rescreens: [] });
  return { dir, path, key, vault };
}

test('real vault projection uses effective retention and no identity/evidence or filesystem writes', t => {
  const f = fixture(t); f.vault.extendRetention('PRIVATE-RECORD', 5000, 'operator', 'synthetic-policy', 2);
  const bytes = readFileSync(f.path), snapshot = f.vault.monitoringSnapshot();
  assert.equal(snapshot.records[0].retentionUntil, 5000);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE-NAME'), false); assert.equal(JSON.stringify(snapshot).includes('PRIVATE-EVIDENCE'), false);
  assert.equal(monitorVault(snapshot, limits, 2000).counts.RETAINED_RECORD_OUTSIDE_SCREENING, undefined);
  assert.deepEqual(readFileSync(f.path), bytes);
  const missing = join(f.dir, 'absent', 'vault.enc');
  assert.throws(() => new EvidenceVault(missing, f.key).monitoringSnapshot(), /NOT_FOUND/);
  assert.equal(existsSync(join(f.dir, 'absent')), false);
});

test('actual monitor CLI has explicit thresholds, redacted findings, no mutation and distinct unavailable exit', t => {
  const f = fixture(t), bytes = readFileSync(f.path);
  const env = { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: f.path, EVIDENCE_VAULT_KEY: f.key,
    MONITOR_SCREENING_SECONDS: '1', MONITOR_ISSUANCE_SECONDS: '1', MONITOR_REVIEW_RECORD_SECONDS: '1', MONITOR_REVOCATION_SECONDS: '1', MONITOR_OBSERVATION_SECONDS: '1' };
  const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'script/monitor-vault.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { ...env, ...extra },
  });
  const result = run(); assert.equal(result.status, 1); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout); assert.equal(report.counts.RETAINED_RECORD_OUTSIDE_SCREENING, 1);
  assert.equal(report.currentEnforcement, 'NOT_CHECKED'); assert.equal(result.stdout.includes('PRIVATE-'), false);
  assert.deepEqual(readFileSync(f.path), bytes);
  const invalid = run({ MONITOR_REVOCATION_SECONDS: '' }); assert.equal(invalid.status, 2); assert.equal(invalid.stderr.trim(), 'VAULT_MONITOR_UNAVAILABLE');
  const missing = run({ EVIDENCE_VAULT_PATH: join(f.dir, 'absent', 'vault.enc') }); assert.equal(missing.status, 2);
  assert.equal(existsSync(join(f.dir, 'absent')), false); assert.deepEqual(readFileSync(f.path), bytes);
});
