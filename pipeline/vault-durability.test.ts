import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, VaultBusyError, VaultWriteError, type VaultRecord } from './vault.js';
import { deliverRevocations, type RevocationTransport } from './rescreen.js';

const KEY = 'synthetic-vault-durability-key-at-least-32-characters';
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-vault-io-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), vault = new EvidenceVault(path, KEY);
  const record: VaultRecord = { id: 'synthetic', walletAddress: '0x' + 'ab'.repeat(20), consentVersion: 'fixture',
    screeningSubject: { fullName: 'PRIVATE-NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + 'ab'.repeat(20) },
    evidenceHash: 'synthetic-hash', evidence: { note: 'PRIVATE-EVIDENCE' }, state: 'active', createdAt: 100, retentionUntil: 1000, reviews: [], rescreens: [] };
  vault.put(record); return { dir, path, vault, record };
}

test('file write/fsync/rename/directory fsync faults never acknowledge BLOCK and retain a cross-instance writer fence', t => {
  for (const phase of ['write', 'file-sync', 'rename', 'directory-sync'] as const) {
    const f = fixture(t), bytes = readFileSync(f.path); let injected = false;
    const sync = fs.fsyncSync, write = fs.writeFileSync, rename = fs.renameSync;
    const fail = () => { injected = true; throw new Error('PRIVATE-FILESYSTEM-DIAGNOSTIC'); };
    const hooks = [
      t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => { if (phase === 'write') fail(); return write(...args); }),
      t.mock.method(fs, 'fsyncSync', (fd: number) => {
        if ((phase === 'file-sync' && !fs.fstatSync(fd).isDirectory()) || (phase === 'directory-sync' && fs.fstatSync(fd).isDirectory())) fail();
        return sync(fd);
      }),
      t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => { if (phase === 'rename') fail(); return rename(...args); }),
    ];
    try {
      assert.throws(() => f.vault.recordRescreen(f.record.id, { at: 200, decision: 'BLOCK', listVersions: {} }, f.record), { message: 'VAULT_WRITE_UNCONFIRMED' });
    } finally { hooks.forEach(hook => hook.mock.restore()); }
    assert.equal(injected, true); assert.equal(existsSync(`${f.path}.lock`), true);
    assert.equal(JSON.parse(readFileSync(`${f.path}.lock`, 'utf8')).pid, process.pid);
    if (phase !== 'directory-sync') assert.deepEqual(readFileSync(f.path), bytes);
    const reopened = new EvidenceVault(f.path, KEY, { lockWaitMs: 0 });
    assert.equal(reopened.get(f.record.id)!.state, phase === 'directory-sync' ? 'blocked' : 'active');
    assert.equal(reopened.listPendingRevocations().length, phase === 'directory-sync' ? 1 : 0);
    assert.throws(() => f.vault.put({ ...f.record, id: 'same-instance' }), VaultWriteError);
    assert.throws(() => reopened.put({ ...f.record, id: 'new-instance' }), VaultBusyError);
    assert.equal(readdirSync(f.dir).some(name => name.endsWith('.tmp')), false);
    assert.equal(readFileSync(f.path, 'utf8').includes('PRIVATE-'), false);
  }
});

test('post-rename signature save failure blocks existing-envelope delivery from both original and reopened vault', async t => {
  const f = fixture(t);
  f.vault.recordRescreen(f.record.id, { at: 200, decision: 'BLOCK', listVersions: {} }, f.record);
  const job = f.vault.listPendingRevocations()[0], sync = fs.fsyncSync;
  const hook = t.mock.method(fs, 'fsyncSync', (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('SYNTHETIC_DIR_FSYNC'); return sync(fd); });
  const transaction = { hash: 'synthetic-transaction', raw: 'PRIVATE-SIGNED-BYTES', chainId: 11155111, source: 'synthetic-source' };
  try { assert.throws(() => f.vault.prepareRevocation(job.id, transaction), VaultWriteError); }
  finally { hook.mock.restore(); }
  const reopened = new EvidenceVault(f.path, KEY); assert.deepEqual(reopened.getRevocation(job.id)!.transaction, transaction);
  let calls = 0; const unexpected = async () => { calls++; throw new Error('must not call transport while vault is fenced'); };
  const transport: RevocationTransport = { assertJob: () => { calls++; }, prepare: unexpected, receipt: unexpected, broadcast: unexpected, wait: unexpected };
  await assert.rejects(deliverRevocations(f.vault, transport), VaultWriteError);
  await assert.rejects(deliverRevocations(reopened, transport), VaultWriteError);
  assert.equal(calls, 0); assert.equal(existsSync(`${f.path}.lock`), true);
  assert.equal(reopened.getRevocation(job.id)!.state, 'prepared');

  const later = fixture(t);
  later.vault.recordRescreen(later.record.id, { at: 200, decision: 'BLOCK', listVersions: {} }, later.record);
  const laterJob = later.vault.listPendingRevocations()[0]; later.vault.prepareRevocation(laterJob.id, transaction);
  const boundedLater = new EvidenceVault(later.path, KEY, { lockWaitMs: 0 });
  let broadcasts = 0;
  await assert.rejects(deliverRevocations(boundedLater, { ...transport, assertJob: () => {},
    receipt: async () => { fs.writeFileSync(`${later.path}.lock`, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return null; },
    broadcast: async () => { broadcasts++; },
  }), VaultBusyError);
  assert.equal(broadcasts, 0, 'a writer lock appearing during receipt lookup fences the following broadcast');
  assert.equal(later.vault.getRevocation(laterJob.id)!.state, 'prepared');
});

test('ordinary rejected mutations release their lock and do not poison the writer', t => {
  const f = fixture(t), bytes = readFileSync(f.path);
  assert.throws(() => f.vault.put({ ...f.record, evidenceHash: 'different' }), /conflicts/);
  assert.deepEqual(readFileSync(f.path), bytes); assert.equal(existsSync(`${f.path}.lock`), false);
  f.vault.put({ ...f.record, id: 'valid-next'}); assert.ok(f.vault.get('valid-next'));
  assert.equal(existsSync(`${f.path}.lock`), false);
});

test('successful encrypted publication orders file sync before rename and directory sync, with restrictive permissions', t => {
  const f = fixture(t), events: string[] = [], sync = fs.fsyncSync, rename = fs.renameSync;
  const hooks = [t.mock.method(fs, 'fsyncSync', (fd: number) => { events.push(fs.fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync'); sync(fd); }),
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => { events.push('rename'); rename(...args); })];
  try { f.vault.put({ ...f.record, id: 'second' }); }
  finally { hooks.forEach(hook => hook.mock.restore()); }
  assert.deepEqual(events, ['file-sync', 'rename', 'directory-sync']); assert.equal(statSync(f.path).mode & 0o777, 0o600);
  assert.equal(existsSync(`${f.path}.lock`), false); assert.equal(readdirSync(f.dir).some(name => name.endsWith('.tmp')), false);
  assert.ok(new EvidenceVault(f.path, KEY).get('second'));
});
