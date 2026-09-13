import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, VaultRestoreError, type VaultRecord } from './vault.js';
import { SYNTHETIC_RETENTION_POLICY, retentionPolicyEvidence } from './retention-policy.js';

const OLD_KEY = 'synthetic-recovery-old-key-at-least-32-characters';
const NEW_KEY = 'synthetic-recovery-next-key-at-least-32-characters';
const transactionHash = `0x${'44'.repeat(32)}`;
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-vault-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc');
  const record: VaultRecord = { id: 'synthetic-issued', walletAddress: `0x${'ab'.repeat(20)}`, consentVersion: 'synthetic-v1',
    screeningSubject: { fullName: 'SYNTHETIC PRIVATE NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR',
      walletAddress: `0x${'ab'.repeat(20)}` }, attrs: `0x${'11'.repeat(32)}`, claimsRoot: `0x${'22'.repeat(32)}`,
    evidenceHash: `0x${'33'.repeat(32)}`, evidence: { private: 'SYNTHETIC PRIVATE EVIDENCE' }, state: 'active',
    createdAt: 100, retentionUntil: 10_000, reviews: [], rescreens: [], sourceIssuance: {
      transactionHash, chainId: 11155111, source: `0x${'55'.repeat(20)}`, observedAt: 200, hubMaterialized: true,
    } };
  const vault = new EvidenceVault(path, OLD_KEY); vault.put(record);
  return { dir, path, record, vault };
}

test('authenticated backup restores into an empty path and exact supplied commitments match', t => {
  const f = fixture(t), backup = join(f.dir, 'backups', 'vault.backup'), restored = join(f.dir, 'restore', 'vault.enc');
  const sourceBytes = readFileSync(f.path), manifest = f.vault.createBackup(backup, 1_000);
  assert.equal(readFileSync(backup, 'utf8').includes('SYNTHETIC PRIVATE'), false);
  assert.equal(statSync(backup).mode & 0o777, 0o600);
  const backupBytes = readFileSync(backup);
  assert.throws(() => f.vault.createBackup(backup, 1_001), /VAULT_BACKUP_UNCONFIRMED/);
  assert.deepEqual(readFileSync(backup), backupBytes);
  const started = Date.now();
  const result = EvidenceVault.restoreBackup(backup, restored, OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment, minimumRevision: manifest.revision, erasedRecordIds: [],
    commitments: [{ recordId: f.record.id, walletAddress: f.record.walletAddress, claimsRoot: f.record.claimsRoot!,
      evidenceHash: f.record.evidenceHash, sourceTransactionHash: transactionHash }],
  });
  const rtoMs = Date.now() - started, rpoMs = Math.max(0, started - manifest.createdAt);
  assert.equal(result.matchedCommitments, 1);
  assert.deepEqual(readFileSync(restored), sourceBytes);
  assert.deepEqual(new EvidenceVault(restored, OLD_KEY).get(f.record.id), f.record);
  assert.ok(rpoMs >= 0); assert.ok(rtoMs < 5_000);
  assert.throws(() => EvidenceVault.restoreBackup(backup, restored, OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment,
    minimumRevision: manifest.revision, commitments: [], erasedRecordIds: [],
  }), /DESTINATION_NOT_EMPTY/);
});

test('restore rejects stale revision floors, commitment mismatches, altered backup bytes and wrong keys', t => {
  const f = fixture(t), backup = join(f.dir, 'vault.backup');
  const manifest = f.vault.createBackup(backup, 1_000);
  f.vault.placeHold(f.record.id, 'later-hold', 'synthetic-operator', 'SYNTHETIC-CASE', 1_100);
  const current = f.vault.recoveryState();
  assert.ok(current.revision > manifest.revision);
  assert.throws(() => EvidenceVault.restoreBackup(backup, join(f.dir, 'stale.enc'), OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment,
    minimumRevision: current.revision, commitments: [], erasedRecordIds: [],
  }), VaultRestoreError);
  assert.throws(() => EvidenceVault.restoreBackup(backup, join(f.dir, 'mismatch.enc'), OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment, minimumRevision: manifest.revision,
    erasedRecordIds: [], commitments: [{ recordId: f.record.id, walletAddress: f.record.walletAddress, evidenceHash: `0x${'99'.repeat(32)}` }],
  }), /ONCHAIN_COMMITMENT_MISMATCH/);
  assert.throws(() => EvidenceVault.restoreBackup(backup, join(f.dir, 'wrong-key.enc'), NEW_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment, minimumRevision: manifest.revision, commitments: [], erasedRecordIds: [],
  }), /AUTHENTICATION_FAILED/);
  const parsed = JSON.parse(readFileSync(backup, 'utf8')); parsed.revision += 1; writeFileSync(backup, JSON.stringify(parsed));
  assert.throws(() => EvidenceVault.restoreBackup(backup, join(f.dir, 'tampered.enc'), OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment, minimumRevision: manifest.revision, commitments: [], erasedRecordIds: [],
  }), /AUTHENTICATION_FAILED/);
});

test('PM-T33 restore rejects a backup that predates an independently retained erasure tombstone', t => {
  const f = fixture(t), backup = join(f.dir, 'pre-erasure.backup'), restored = join(f.dir, 'resurrected.enc');
  const now = Date.now();
  const retention = retentionPolicyEvidence(SYNTHETIC_RETENTION_POLICY, {
    customerId: 'synthetic-demo-only', jurisdiction: 'KR', outcome: 'issued', collectedAt: now, decisionAt: now,
  });
  const bound: VaultRecord = { ...f.record, id: 'policy-bound-record', createdAt: now,
    retentionUntil: retention.vaultDeleteAt, retentionPolicy: retention };
  f.vault.put(bound);
  const manifest = f.vault.createBackup(backup, now);
  assert.equal(manifest.deleteBy, retention.vaultDeleteAt);
  assert.throws(() => EvidenceVault.restoreBackup(backup, restored, OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment,
    minimumRevision: manifest.revision, commitments: [], erasedRecordIds: [bound.id],
  }), /ERASURE_FLOOR_VIOLATION/);
  t.mock.method(Date, 'now', () => retention.vaultDeleteAt);
  assert.throws(() => EvidenceVault.restoreBackup(backup, restored, OLD_KEY, {
    expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment,
    minimumRevision: manifest.revision, commitments: [], erasedRecordIds: [],
  }), /BACKUP_EXPIRED/);
  assert.equal(readFileSync(backup, 'utf8').includes('SYNTHETIC PRIVATE'), false);
});

test('key rotation preserves state, changes revision/key identity, invalidates old review capability and rejects the old key', t => {
  const f = fixture(t), before = f.vault.recoveryState(), oldReview = f.vault.reviewSnapshot(f.record.id).revision;
  const rotated = f.vault.rotateKey(NEW_KEY, 'synthetic-key-custodian', 2_000);
  assert.ok(rotated.revision > before.revision);
  assert.notEqual(rotated.previousKeyId, rotated.nextKeyId);
  assert.deepEqual(f.vault.get(f.record.id), f.record);
  assert.deepEqual(new EvidenceVault(f.path, NEW_KEY).get(f.record.id), f.record);
  assert.throws(() => new EvidenceVault(f.path, OLD_KEY), /authentication failed/);
  assert.throws(() => f.vault.decideReview(f.record.id, { at: 2_100, operator: 'synthetic-reviewer', outcome: 'cleared',
    reason: 'SYNTHETIC-DECISION' }, oldReview), /REVIEW_RECORD_CHANGED/);
  const currentReview = f.vault.reviewSnapshot(f.record.id).revision;
  assert.equal(f.vault.decideReview(f.record.id, { at: 2_100, operator: 'synthetic-reviewer', outcome: 'cleared',
    reason: 'SYNTHETIC-DECISION' }, currentReview).state, 'active');
});

test('recovery CLI creates a private backup and requires explicit restore execution', t => {
  const f = fixture(t), backup = join(f.dir, 'cli.backup'), restored = join(f.dir, 'cli-restored.enc');
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'script/vault-recovery.ts', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: f.path, EVIDENCE_VAULT_KEY: OLD_KEY },
  });
  const made = run('backup', backup); assert.equal(made.status, 0, made.stderr);
  const manifest = JSON.parse(made.stdout);
  const requirements = join(f.dir, 'requirements.json');
  writeFileSync(requirements, JSON.stringify({ expectedBackupId: manifest.backupId, expectedStateCommitment: manifest.stateCommitment,
    minimumRevision: manifest.revision, commitments: [], erasedRecordIds: [] }));
  assert.notEqual(run('restore', backup, restored, requirements).status, 0);
  const result = run('restore', backup, restored, requirements, '--execute');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(new EvidenceVault(restored, OLD_KEY).get(f.record.id));
  assert.notEqual(run('rotate-key').status, 0);
});
