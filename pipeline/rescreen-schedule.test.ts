import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import {
  monitorRescreenSchedule,
  readRescreenRunState,
  writeRescreenRunState,
  type RescreenRunState,
} from './rescreen-schedule.js';
const SNAPSHOT = 'ab'.repeat(32);

const success = (changes: Partial<RescreenRunState> = {}): RescreenRunState => ({
  version: 2,
  scheduleId: 'synthetic-schedule',
  sanctionsSnapshotId: SNAPSHOT,
  phase: 'succeeded',
  scheduleIntervalMs: 1_000,
  startedAt: 100,
  completedAt: 200,
  due: 0,
  blocked: 0,
  sourceConfirmed: 0,
  pending: 0,
  ...changes,
} as RescreenRunState);

test('missing or stale scheduler evidence cannot look healthy when the vault has no due records', () => {
  const running = { version: 2, scheduleId: 'synthetic-schedule', sanctionsSnapshotId: SNAPSHOT, phase: 'running', scheduleIntervalMs: 1_000, startedAt: 100 } as const;
  const limits = { scheduleId: 'synthetic-schedule', sanctionsSnapshotId: SNAPSHOT, scheduleIntervalMs: 1_000, maxRunMs: 500 };
  assert.equal(monitorRescreenSchedule(running, limits, 599).status, 'NO_LOCAL_FINDINGS');
  const stalled = monitorRescreenSchedule(running, limits, 600);
  assert.equal(stalled.status, 'ATTENTION_REQUIRED');
  assert.equal(stalled.counts.RUN_STALLED, 1);
  const missed = monitorRescreenSchedule(success(), limits, 1_100);
  assert.equal(missed.counts.RUN_MISSED, 1);
  assert.throws(() => readRescreenRunState('/path/that/does/not/exist'));
});

test('failed and incomplete successful runs remain alertable without projecting error text or identifiers', () => {
  const limits = { scheduleId: 'synthetic-schedule', sanctionsSnapshotId: SNAPSHOT, scheduleIntervalMs: 1_000, maxRunMs: 500 };
  const failed = monitorRescreenSchedule({ version: 2, scheduleId: 'synthetic-schedule', sanctionsSnapshotId: SNAPSHOT, phase: 'failed', scheduleIntervalMs: 1_000,
    startedAt: 100, completedAt: 200 }, limits, 201);
  assert.equal(failed.counts.LAST_RUN_FAILED, 1);
  const pending = monitorRescreenSchedule(success({ pending: 2 }), limits, 201);
  assert.equal(pending.counts.LAST_RUN_PENDING, 1);
  for (const report of [failed, pending]) {
    assert.equal(report.alertDelivery, 'NOT_CONFIGURED');
    assert.equal(report.currentEnforcement, 'NOT_CHECKED');
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
});

test('run-state validation rejects changed schedules, impossible clocks and inconsistent counts', () => {
  const limits = { scheduleId: 'synthetic-schedule', sanctionsSnapshotId: SNAPSHOT, scheduleIntervalMs: 1_000, maxRunMs: 500 };
  for (const value of [
    success({ scheduleIntervalMs: 2_000 }), success({ completedAt: 99 }), success({ startedAt: 300 }),
    success({ due: 0, blocked: 1 }), success({ sourceConfirmed: -1 }), success({ sanctionsSnapshotId: 'cd'.repeat(32) }),
    { ...success(), phase: 'invented' }, { ...success(), secret: 'PRIVATE' },
  ]) assert.throws(() => monitorRescreenSchedule(value, limits, 300));
  for (const changed of [{ scheduleIntervalMs: 0 }, { maxRunMs: 0 }, { maxRunMs: Number.NaN }]) {
    assert.throws(() => monitorRescreenSchedule(success(), { ...limits, ...changed }, 300));
  }
});

test('atomic state file and monitor CLI distinguish fresh, attention and unavailable without mutation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-rescreen-schedule-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'run.json');
  writeRescreenRunState(path, success({ startedAt: Date.now() - 10, completedAt: Date.now() }));
  assert.deepEqual(readRescreenRunState(path), JSON.parse(readFileSync(path, 'utf8')));
  const run = (extra: Record<string, string> = {}) => spawnSync(process.execPath, ['--import', 'tsx', 'script/monitor-rescreen.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, RESCREEN_RUN_STATE_PATH: path, RESCREEN_SCHEDULE_ID: 'synthetic-schedule', RESCREEN_SCHEDULE_INTERVAL_SECONDS: '1',
      MONITOR_RESCREEN_RUN_SECONDS: '1', SANCTIONS_EXPECTED_SNAPSHOT_ID: SNAPSHOT, ...extra },
  });
  const bytes = readFileSync(path), fresh = run();
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(JSON.parse(fresh.stdout).status, 'NO_LOCAL_FINDINGS');
  assert.deepEqual(readFileSync(path), bytes);
  writeRescreenRunState(path, success({ startedAt: 1, completedAt: 2 }));
  const missed = run(); assert.equal(missed.status, 1, missed.stderr);
  assert.equal(JSON.parse(missed.stdout).counts.RUN_MISSED, 1);
  const absent = join(dir, 'absent', 'run.json');
  const unavailable = run({ RESCREEN_RUN_STATE_PATH: absent });
  assert.equal(unavailable.status, 2); assert.equal(unavailable.stdout, '');
  assert.equal(unavailable.stderr.trim(), 'RESCREEN_MONITOR_UNAVAILABLE');
  assert.equal(existsSync(join(dir, 'absent')), false);
});

test('scheduled publisher records a redacted failed attempt while invalid arguments write nothing', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-rescreen-scheduled-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const vaultPath = join(dir, 'vault', 'evidence.enc'), statePath = join(dir, 'status', 'run.json');
  const env = { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: vaultPath,
    EVIDENCE_VAULT_KEY: 'synthetic-scheduled-vault-key-at-least-32-characters',
    EVIDENCE_HMAC_KEY: 'PRIVATE-HMAC-KEY-NOT-FOR-OUTPUT-32-CHARS',
    SOURCE_CHAIN_RPC_URL: 'http://127.0.0.1:1', SOURCE_CHAIN_ID: '11155111',
    SOURCE_CONTRACT_ADDRESS: '0x' + '11'.repeat(20), RESCREEN_PRIVATE_KEY: '0x' + '22'.repeat(32),
    RESCREEN_SIGNER_ADDRESS: new ethers.Wallet('0x' + '22'.repeat(32)).address,
    RESCREEN_RUN_STATE_PATH: statePath, RESCREEN_SCHEDULE_ID: 'synthetic-cli-schedule', RESCREEN_SCHEDULE_INTERVAL_SECONDS: '60',
    SANCTIONS_EXPECTED_SNAPSHOT_ID: SNAPSHOT };
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'script/rescreen.ts', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, env,
  });
  const invalid = run(['--publish', '--scheduled', '--typo']);
  assert.notEqual(invalid.status, 0); assert.equal(existsSync(statePath), false); assert.equal(existsSync(join(dir, 'status')), false);
  const failed = run(['--publish', '--scheduled']);
  assert.notEqual(failed.status, 0); assert.equal(readRescreenRunState(statePath).phase, 'failed');
  const bytes = readFileSync(statePath, 'utf8');
  for (const secret of ['PRIVATE-HMAC', env.EVIDENCE_VAULT_KEY, env.RESCREEN_PRIVATE_KEY, env.SOURCE_CONTRACT_ADDRESS, vaultPath]) {
    assert.equal(bytes.includes(secret), false);
  }
  assert.equal(existsSync(vaultPath), false);
});
