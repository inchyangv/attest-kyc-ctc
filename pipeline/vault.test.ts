import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, type VaultRecord } from './vault.js';

const KEY = 'test-only-vault-key-that-is-long-enough-123456';

function fixture(): { dir: string; path: string; record: VaultRecord } {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-vault-'));
  return {
    dir,
    path: join(dir, 'evidence.enc'),
    record: {
      id: 'flow-1', walletAddress: '0x' + 'ab'.repeat(20), consentVersion: 'proofmark-kyc-v2',
      screeningSubject: { fullName: '박서준', dateOfBirth: '1988-03-14', nationality: 'KR', residence: 'KR', walletAddress: '0x' + 'ab'.repeat(20) },
      evidenceHash: '0x' + '11'.repeat(32), evidence: [{ step: 'aml' }], state: 'active',
      createdAt: 100, retentionUntil: 10_000, rescreens: [], reviews: [],
    },
  };
}

describe('encrypted evidence vault', () => {
  test('pending issuance is idempotent and is activated only by matching materialization', () => {
    const f = fixture();
    try {
      const vault = new EvidenceVault(f.path, KEY);
      f.record.state = 'pending'; vault.put(f.record);
      vault.put({ ...f.record, state: 'active' });
      assert.equal(vault.get(f.record.id)?.state, 'pending');
      assert.deepEqual(vault.listForRescreen(200, 1), []);
      assert.throws(() => vault.recordMaterialization(f.record.id, 'different-hash'), /does not match/);
      assert.equal(vault.get(f.record.id)?.state, 'pending');
      vault.recordMaterialization(f.record.id, f.record.evidenceHash);
      assert.equal(new EvidenceVault(f.path, KEY).get(f.record.id)?.state, 'active');
      assert.equal(vault.listForRescreen(200, 1).length, 1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('late materialization cannot undo a review or block decision', () => {
    const f = fixture();
    try {
      const vault = new EvidenceVault(f.path, KEY);
      f.record.state = 'pending'; vault.put(f.record);
      vault.recordRescreen(f.record.id, { at: 200, decision: 'REVIEW', reason: 'manual review', listVersions: {} }, vault.get(f.record.id)!);
      vault.recordMaterialization(f.record.id, f.record.evidenceHash);
      assert.equal(vault.get(f.record.id)?.state, 'review');
      vault.recordRescreen(f.record.id, { at: 300, decision: 'BLOCK', reason: 'blocked', listVersions: {} }, vault.get(f.record.id)!);
      vault.recordMaterialization(f.record.id, f.record.evidenceHash);
      assert.equal(vault.get(f.record.id)?.state, 'blocked');
      assert.equal(vault.listPendingRevocations().length, 1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('persists and reopens without cleartext PII on disk', () => {
    const f = fixture();
    try {
      const vault = new EvidenceVault(f.path, KEY);
      vault.put(f.record);
      const raw = readFileSync(f.path, 'utf8');
      assert.equal(raw.includes('박서준'), false);
      assert.equal(new EvidenceVault(f.path, KEY).get('flow-1')?.screeningSubject.fullName, '박서준');
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('wrong key or tampering fails authentication', () => {
    const f = fixture();
    try {
      new EvidenceVault(f.path, KEY).put(f.record);
      assert.throws(() => new EvidenceVault(f.path, 'another-key-that-is-definitely-long-enough-123'), /authentication failed/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('rescreen and human appeal transitions are recorded', () => {
    const f = fixture();
    try {
      const vault = new EvidenceVault(f.path, KEY);
      vault.put(f.record);
      assert.equal(vault.recordRescreen('flow-1', { at: 200, decision: 'REVIEW', reason: 'NAME_SIMILARITY', listVersions: { OFAC_SDN: 1 } }, vault.get('flow-1')!).state, 'review');
      const cleared = vault.decideReview('flow-1', { at: 300, operator: 'compliance-1', outcome: 'cleared', reason: 'false-positive' }, vault.reviewSnapshot('flow-1').revision);
      assert.equal(cleared.state, 'active');
      assert.equal(cleared.reviews.length, 1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('approved erasure removes the personal record and retains a deletion tombstone', () => {
    const f = fixture();
    try {
      const vault = new EvidenceVault(f.path, KEY);
      vault.put(f.record);
      const request = vault.requestDeletion('flow-1', { operator: 'requester', policyRef: 'synthetic-policy-v1',
        serviceRef: 'synthetic-decision-1', disposition: 'unchanged', automatic: false }, 200);
      vault.approveDeletion('flow-1', request.id, 'approver', 300);
      assert.equal(vault.erase('flow-1', request.id, 10_000), true);
      assert.equal(vault.get('flow-1'), undefined);
      assert.deepEqual(vault.counts(), { erased: 1 });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
