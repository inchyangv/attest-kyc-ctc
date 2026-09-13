import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sourceEpochRecord, writeEpochRecord } from './epoch-record.js';

const record = { epoch: 1, root: 'synthetic-root', listVersion: 1, validUntil: 200,
  sourceCutoff: 100, publishedAt: 110, snapshotId: 'synthetic-snapshot', publishEpochTx: 'synthetic-tx',
  sepoliaBlock: 10, sourceSnapshot: { source: 'synthetic-source', cutoffBlockHash: 'synthetic-cutoff' } };
function fixture(t: { after(fn: () => void): void }) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'proofmark-epoch-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'epoch.json'), snippet: join(dir, 'epoch.md') };
}

test('source record projection drops every old hub observation and replacement removes stale PASS prose', t => {
  const f = fixture(t);
  const prior = { ...record, cc3AcceptedAt: 'past', propagationSeconds: 12, propagationMethod: 'past',
    checkedAt: 'past', registryProofMode: true, checks: [{ actual: true }], offChainChecks: [{ actual: true }], hubObservation: { blockNumber: 1 }, policyObservation: { policies: [] }, runtimeObservation: { source: {} }, hubCarry: { transactionHash: 'old' }, sourcePublicationObservation: { transactionHash: 'old' } };
  fs.writeFileSync(f.path, JSON.stringify(prior)); fs.writeFileSync(f.snippet, 'STALE SUBMISSION PASS');
  const current = sourceEpochRecord(prior);
  assert.deepEqual(current, record); assert.equal(prior.checkedAt, 'past', 'does not mutate input history');
  writeEpochRecord(f.path, current);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.path, 'utf8')), record);
  assert.match(fs.readFileSync(f.snippet, 'utf8'), /verification not established/);
  assert.doesNotMatch(fs.readFileSync(f.snippet, 'utf8'), /STALE SUBMISSION PASS/);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(f.dir).some(p => p.endsWith('.tmp')), false);
});

test('record source identity conflicts, missing prior facts and corrupt evidence never overwrite existing files', t => {
  const f = fixture(t); writeEpochRecord(f.path, record);
  const bytes = fs.readFileSync(f.path), snippet = fs.readFileSync(f.snippet);
  for (const changed of [{ ...record, root: 'other' }, { ...record, publishEpochTx: undefined },
    { ...record, sourceSnapshot: { ...record.sourceSnapshot, cutoffBlockHash: 'other' } }]) {
    assert.throws(() => writeEpochRecord(f.path, changed), /EPOCH_RECORD_IDENTITY_CHANGED/);
    assert.deepEqual(fs.readFileSync(f.path), bytes); assert.deepEqual(fs.readFileSync(f.snippet), snippet);
  }
  // Object key order is not a source identity change.
  writeEpochRecord(f.path, { ...record, sourceSnapshot: { cutoffBlockHash: 'synthetic-cutoff', source: 'synthetic-source' } });
  fs.writeFileSync(f.path, '{bad');
  assert.throws(() => writeEpochRecord(f.path, record), /EPOCH_RECORD_UNAVAILABLE/);
  assert.equal(fs.readFileSync(f.path, 'utf8'), '{bad');
  assert.throws(() => writeEpochRecord(f.snippet, record), /EPOCH_RECORD_PATH_INVALID/);
});

test('failed record rename retains previous complete JSON and invalidates old PASS snippet without claiming success', t => {
  const f = fixture(t); writeEpochRecord(f.path, record);
  fs.writeFileSync(f.snippet, 'STALE SUBMISSION PASS'); const before = fs.readFileSync(f.path);
  const rename = fs.renameSync;
  const hook = t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => {
    if (args[1] === f.path) throw new Error('PRIVATE_FILESYSTEM_DIAGNOSTIC');
    return rename(...args);
  });
  try { assert.throws(() => writeEpochRecord(f.path, { ...record, checkedAt: 'new' }), { message: 'EPOCH_RECORD_WRITE_UNCONFIRMED' }); }
  finally { hook.mock.restore(); }
  assert.deepEqual(fs.readFileSync(f.path), before);
  assert.match(fs.readFileSync(f.snippet, 'utf8'), /verification not established/);
  assert.equal(fs.readdirSync(f.dir).some(p => p.endsWith('.tmp')), false);
});
