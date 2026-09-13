import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EvidenceVault, ReviewConflictError, type VaultRecord, type ReviewEvent } from './vault.js';

const KEY = 'synthetic-review-fence-secret-at-least-32-characters';
const decision: ReviewEvent = { at: 200, operator: 'reviewer-a', outcome: 'cleared', reason: 'case-123' };
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-review-fence-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), vault = new EvidenceVault(path, KEY);
  const record: VaultRecord = { id: 'opaque-case', walletAddress: '0x' + 'ab'.repeat(20), consentVersion: 'synthetic',
    screeningSubject: { fullName: 'PRIVATE-NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + 'ab'.repeat(20) },
    evidenceHash: 'synthetic', evidence: { note: 'PRIVATE-EVIDENCE' }, state: 'active', createdAt: 100, retentionUntil: 1000, reviews: [], rescreens: [] };
  vault.put(record); return { dir, path, vault, record };
}

test('concurrent same-time human decisions cannot both commit even when state remains active', t => {
  for (const outcome of ['cleared', 'blocked'] as const) {
    const f = fixture(t), reviewer = new EvidenceVault(f.path, KEY), old = reviewer.reviewSnapshot(f.record.id);
    f.vault.decideReview(f.record.id, { ...decision, outcome }, old.revision);
    const before = readFileSync(f.path);
    assert.throws(() => reviewer.decideReview(f.record.id, { ...decision, operator: 'reviewer-b' }, old.revision), ReviewConflictError);
    assert.deepEqual(readFileSync(f.path), before); assert.equal(f.vault.get(f.record.id)!.reviews.length, 1);
    assert.equal(f.vault.get(f.record.id)!.reviews[0].basedOn, old.revision);
    assert.equal(f.vault.get(f.record.id)!.state, outcome === 'cleared' ? 'active' : 'blocked');
  }
});

test('rescreen, source acknowledgement, retention and outbox-only changes invalidate a reviewed revision', t => {
  for (const change of ['rescreen', 'source', 'hold', 'retention', 'outbox'] as const) {
    const f = fixture(t);
    if (change === 'outbox') f.vault.decideReview(f.record.id, { ...decision, outcome: 'blocked' }, f.vault.reviewSnapshot(f.record.id).revision);
    const snapshot = f.vault.reviewSnapshot(f.record.id);
    if (change === 'rescreen') f.vault.recordRescreen(f.record.id, { at: 200, decision: 'REVIEW', listVersions: { OFAC_SDN: 2 } }, snapshot.record);
    if (change === 'source') f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash,
      { observedAt: 200, source: '0x' + 'cd'.repeat(20), chainId: 11155111, transactionHash: '0x' + 'ef'.repeat(32) });
    if (change === 'hold') f.vault.placeHold(f.record.id, 'legal-hold', 'operator', 'case-ref', 200);
    if (change === 'retention') f.vault.extendRetention(f.record.id, 2000, 'operator', 'policy-ref', 200);
    if (change === 'outbox') f.vault.failRevocation(f.vault.listPendingRevocations()[0].id, 'PRIVATE-DIAGNOSTIC');
    const bytes = readFileSync(f.path);
    assert.throws(() => f.vault.decideReview(f.record.id, { ...decision, outcome: 'blocked' }, snapshot.revision), ReviewConflictError);
    assert.deepEqual(readFileSync(f.path), bytes);
  }
});

test('unrelated writes preserve revisions, but approved erasure cannot be resurrected by stale review', t => {
  const f = fixture(t), before = readFileSync(f.path), snapshot = f.vault.reviewSnapshot(f.record.id);
  assert.deepEqual(readFileSync(f.path), before); assert.match(snapshot.revision, /^[0-9a-f]{64}$/);
  f.vault.put({ ...f.record, id: 'other' }); assert.equal(f.vault.reviewSnapshot(f.record.id).revision, snapshot.revision);
  const request = f.vault.requestDeletion(f.record.id, { operator: 'requester', policyRef: 'policy', serviceRef: 'service', disposition: 'unchanged', automatic: false }, 1100);
  f.vault.approveDeletion(f.record.id, request.id, 'approver', 1200);
  const old = f.vault.reviewSnapshot(f.record.id); assert.equal(f.vault.erase(f.record.id, request.id, 1300), true);
  const erased = readFileSync(f.path);
  assert.throws(() => f.vault.decideReview(f.record.id, { ...decision, at: 1400 }, old.revision), ReviewConflictError);
  assert.deepEqual(readFileSync(f.path), erased); assert.equal(f.vault.get(f.record.id), undefined);
  const missing = join(f.dir, 'absent', 'vault.enc');
  assert.throws(() => new EvidenceVault(missing, KEY).reviewSnapshot('missing'));
  assert.equal(existsSync(join(f.dir, 'absent')), false);
});

test('review requires a case-bound revision, valid monotonic decisions and opaque actor/case references', t => {
  const f = fixture(t), snapshot = f.vault.reviewSnapshot(f.record.id), bytes = readFileSync(f.path);
  for (const revision of [undefined, '', 'a'.repeat(64)]) {
    assert.throws(() => f.vault.decideReview(f.record.id, decision, revision as string), ReviewConflictError);
  }
  for (const change of [{ at: -1 }, { at: 99 }, { at: NaN }, { outcome: 'unknown' }, { operator: '' }, { reason: 'PRIVATE free text' }]) {
    assert.throws(() => f.vault.decideReview(f.record.id, { ...decision, ...change } as ReviewEvent, snapshot.revision));
  }
  assert.deepEqual(readFileSync(f.path), bytes);
  f.vault.decideReview(f.record.id, Object.assign({ ...decision }, { basedOn: 'FORGED', private: 'PRIVATE-EXTRA' }), snapshot.revision);
  assert.deepEqual(f.vault.get(f.record.id)!.reviews[0], { ...decision, basedOn: snapshot.revision });
  assert.throws(() => f.vault.decideReview(f.record.id, { ...decision, at: 199 }, f.vault.reviewSnapshot(f.record.id).revision), /precedes/);
});

test('actual review CLI exposes metadata only and requires reviewed revision, operator and explicit opaque reason', t => {
  const f = fixture(t);
  const run = (args: string[], operator = 'cli-reviewer') => spawnSync(process.execPath, ['--import', 'tsx', 'script/vault-admin.ts', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: f.path, EVIDENCE_VAULT_KEY: KEY, COMPLIANCE_OPERATOR_ID: operator },
  });
  const bytes = readFileSync(f.path), preview = run(['review-snapshot', f.record.id]);
  assert.equal(preview.status, 0, preview.stderr); assert.equal(preview.stdout.includes('PRIVATE-'), false);
  const snapshot = JSON.parse(preview.stdout); assert.equal(snapshot.identityEvidence, 'NOT_INCLUDED'); assert.deepEqual(readFileSync(f.path), bytes);
  const args = ['decide', f.record.id, 'cleared', snapshot.revision, 'case-123'];
  const missingActor = run(args, ''); assert.equal(missingActor.status, 1); assert.equal(missingActor.stderr.trim(), 'REVIEW_OPERATION_UNAVAILABLE');
  assert.deepEqual(readFileSync(f.path), bytes);
  const result = run(args); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).currentEnforcement, 'NOT_CHECKED');
  const committed = readFileSync(f.path), replay = run(args); assert.equal(replay.status, 1); assert.equal(replay.stderr.trim(), 'REVIEW_RECORD_CHANGED');
  assert.deepEqual(readFileSync(f.path), committed);
  const legacy = run(['decide', f.record.id, 'cleared', 'PRIVATE free text']);
  assert.equal(legacy.status, 1); assert.equal(legacy.stderr.trim(), 'REVIEW_OPERATION_UNAVAILABLE');
});
