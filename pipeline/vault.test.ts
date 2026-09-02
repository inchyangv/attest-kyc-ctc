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
      assert.equal(vault.recordRescreen('flow-1', { at: 200, decision: 'REVIEW', reason: 'NAME_SIMILARITY', listVersions: { OFAC_SDN: 1 } }).state, 'review');
      const cleared = vault.decideReview('flow-1', { at: 300, operator: 'compliance-1', outcome: 'cleared', reason: 'false positive' });
      assert.equal(cleared.state, 'active');
      assert.equal(cleared.reviews.length, 1);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });

  test('erasure removes the personal record and retains an opaque audit event', () => {
    const f = fixture();
    try {
      const vault = new EvidenceVault(f.path, KEY);
      vault.put(f.record);
      assert.equal(vault.erase('flow-1', 'request upheld'), true);
      assert.equal(vault.get('flow-1'), undefined);
      assert.deepEqual(vault.counts(), { erased: 1 });
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
});
