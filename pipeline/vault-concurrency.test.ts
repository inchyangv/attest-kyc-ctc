import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, type VaultRecord } from './vault.js';

const KEY = 'synthetic-concurrent-vault-key-at-least-32-characters';
const roles = ['api', 'rescreen', 'appeal', 'purge'] as const;

function record(id: string, state: VaultRecord['state'] = 'active'): VaultRecord {
  return { id, walletAddress: `0x${id.charCodeAt(0).toString(16).padStart(2, '0').repeat(20)}`, consentVersion: 'synthetic-v1',
    screeningSubject: { fullName: 'SYNTHETIC PRIVATE NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR',
      walletAddress: `0x${id.charCodeAt(0).toString(16).padStart(2, '0').repeat(20)}` },
    evidenceHash: `0x${id.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`, evidence: { synthetic: true }, state,
    createdAt: 100, retentionUntil: 1_000, reviews: [], rescreens: [] };
}

function child(path: string, role: typeof roles[number]): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/vault-concurrent-writer.ts'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { PATH: process.env.PATH, SYNTHETIC_VAULT_PATH: path, SYNTHETIC_VAULT_KEY: KEY, SYNTHETIC_VAULT_ROLE: role },
  });
}

function message(process: ChildProcess): Promise<{ state: string; role: string; error?: string }> {
  return new Promise((resolve, reject) => {
    process.once('message', value => resolve(value as { state: string; role: string; error?: string }));
    process.once('error', reject);
    process.once('exit', code => { if (code !== null && code !== 0) reject(new Error(`writer exited ${code}`)); });
  });
}

test('PM-T21-01 API, rescreen, appeal and purge wait for one writer and preserve every independent update', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-vault-concurrency-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), vault = new EvidenceVault(path, KEY);
  for (const item of [record('template'), record('rescreen'), record('appeal', 'review'), record('purge')]) vault.put(item);
  const deletion = vault.requestDeletion('purge', { operator: 'synthetic-requester', policyRef: 'SYNTHETIC-POLICY',
    serviceRef: 'SYNTHETIC-SERVICE', disposition: 'unchanged', automatic: true }, 200);
  vault.approveDeletion('purge', deletion.id, 'synthetic-approver', 300);

  // This is a live test-owned writer, not a stale lock. Production code must wait, never unlink it.
  const lock = `${path}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), { flag: 'wx', mode: 0o600 });
  const children = roles.map(role => child(path, role));
  t.after(() => { for (const process of children) if (process.exitCode === null) process.kill('SIGTERM'); });
  assert.deepEqual((await Promise.all(children.map(message))).map(value => value.state), roles.map(() => 'ready'));
  const completions = children.map(message);
  for (const process of children) process.send!('go');
  await new Promise(resolve => setTimeout(resolve, 100));
  unlinkSync(lock);
  const results = await Promise.all(completions);
  assert.deepEqual(results, roles.map(role => ({ state: 'complete', role })));

  const reopened = new EvidenceVault(path, KEY);
  assert.ok(reopened.get('api-created'));
  assert.equal(reopened.get('rescreen')?.state, 'review');
  assert.equal(reopened.get('rescreen')?.rescreens.length, 1);
  assert.equal(reopened.get('appeal')?.state, 'active');
  assert.equal(reopened.get('appeal')?.reviews.length, 1);
  assert.equal(reopened.get('purge'), undefined);
  assert.equal(reopened.counts().erased, 1);
});
