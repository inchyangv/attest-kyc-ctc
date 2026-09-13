import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EvidenceVault, type VaultRecord } from './vault.js';
import { SYNTHETIC_RETENTION_POLICY, retentionPolicyEvidence } from './retention-policy.js';
import { issuanceEvidenceSink } from './issuance-evidence.js';
import type { IssuanceEntry } from './issuance-journal.js';

const KEY = 'synthetic-retention-test-key-at-least-32-characters';
const decision = { operator: 'requester', policyRef: 'SYNTHETIC-POLICY-1', serviceRef: 'SYNTHETIC-SERVICE-1',
  disposition: 'unchanged' as const, automatic: true };
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-retention-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc');
  const record: VaultRecord = { id: 'synthetic-flow', walletAddress: '0x' + 'ab'.repeat(20), consentVersion: 'test-v1',
    screeningSubject: { fullName: 'Synthetic Private Name', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR',
      walletAddress: '0x' + 'ab'.repeat(20) }, evidenceHash: '0x' + '11'.repeat(32), evidence: { private: 'synthetic' },
    state: 'active', createdAt: 100, retentionUntil: 10_000, rescreens: [], reviews: [] };
  const vault = new EvidenceVault(path, KEY); vault.put(record);
  return { dir, path, record, vault };
}
function approve(vault: EvidenceVault, id: string, automatic = true) {
  const request = vault.requestDeletion(id, { ...decision, automatic }, 200);
  vault.approveDeletion(id, request.id, 'approver', 300);
  return request;
}
function legacy(path: string, record: VaultRecord, erased = false) {
  const key = createHash('sha256').update(`${KEY}|proofmark-evidence-vault-v1`).digest();
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = { version: 1, records: erased ? {} : { [record.id]: record },
    erasures: erased ? [{ recordId: record.id, at: 500, reason: 'old-event' }] : [], revocations: {} };
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plaintext)), cipher.final()]);
  writeFileSync(path, JSON.stringify({ version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') }), { mode: 0o600 });
}
function plaintext(path: string) {
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const key = createHash('sha256').update(`${KEY}|proofmark-evidence-vault-v1`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8'));
}

test('legacy deadline alone never authorizes purge; preview is byte-for-byte read only', t => {
  const f = fixture(t); legacy(f.path, f.record);
  const original = readFileSync(f.path);
  assert.deepEqual(f.vault.deletionPreview(20_000)[0].blockers, ['DELETION_NOT_APPROVED']);
  assert.deepEqual(readFileSync(f.path), original);
  assert.equal(f.vault.purgeExpired(20_000), 0);
  assert.equal(plaintext(f.path).version, 2); // The previous v1-only reader rejects this version.
  assert.ok(f.vault.get(f.record.id));
  const missing = join(f.dir, 'absent', 'vault.enc');
  assert.deepEqual(new EvidenceVault(missing, KEY).deletionPreview(), []);
  assert.equal(existsSync(join(f.dir, 'absent')), false);
});

test('approval cannot override deadline; exact expiry purges only automatic decisions', t => {
  const f = fixture(t); const request = approve(f.vault, f.record.id);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 9_999), /RETENTION_NOT_EXPIRED/);
  assert.equal(f.vault.purgeExpired(9_999), 0);
  assert.equal(f.vault.purgeExpired(10_000), 1);
  assert.equal(f.vault.purgeExpired(10_001), 0);
  f.vault.put({ ...f.record, id: 'manual' });
  const manual = approve(f.vault, 'manual', false);
  assert.equal(f.vault.purgeExpired(10_000), 0);
  assert.equal(f.vault.erase('manual', manual.id, 10_000), true);
});

test('request IDs, separate labels and approval time are enforced without changing failed writes', t => {
  const f = fixture(t); const request = f.vault.requestDeletion(f.record.id, decision, 200);
  const original = readFileSync(f.path);
  assert.throws(() => f.vault.approveDeletion(f.record.id, request.id, decision.operator, 300), /different approver/);
  assert.throws(() => f.vault.approveDeletion(f.record.id, 'other-request', 'approver', 300), /not current/);
  assert.throws(() => f.vault.approveDeletion(f.record.id, request.id, 'approver', 199), /precedes/);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 10_000), /DELETION_NOT_APPROVED/);
  assert.deepEqual(readFileSync(f.path), original);
  f.vault.approveDeletion(f.record.id, request.id, 'approver', 10_001);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 10_000), /APPROVAL_TIME_INVALID/);
  assert.throws(() => f.vault.approveDeletion(f.record.id, request.id, 'another', 10_002), /already approved/);
});

test('holds survive restart, block expiry, and release never revives a previous approval', t => {
  const f = fixture(t); const request = approve(f.vault, f.record.id);
  f.vault.placeHold(f.record.id, 'hold-1', 'legal-operator', 'CASE-1', 400);
  const restarted = new EvidenceVault(f.path, KEY);
  assert.equal(restarted.purgeExpired(20_000), 0);
  assert.throws(() => restarted.erase(f.record.id, request.id, 20_000), /LEGAL_HOLD/);
  assert.throws(() => restarted.requestDeletion(f.record.id, decision, 500), /LEGAL_HOLD/);
  restarted.releaseHold(f.record.id, 'hold-1', 'legal-operator', 'CASE-RELEASE-1', 600);
  assert.throws(() => restarted.erase(f.record.id, request.id, 20_000), /DELETION_REQUEST_STALE/);
  assert.throws(() => restarted.placeHold(f.record.id, 'hold-1', 'legal-operator', 'CASE-2', 700), /already used/);
  assert.throws(() => restarted.releaseHold(f.record.id, 'hold-1', 'legal-operator', 'CASE-3', 700), /already released/);
  const next = restarted.requestDeletion(f.record.id, decision, 700);
  restarted.approveDeletion(f.record.id, next.id, 'approver', 800);
  assert.equal(restarted.purgeExpired(10_000), 1);
});

test('retention extensions are monotonic, invalidate approval, and extend rescreen eligibility', t => {
  const f = fixture(t); const request = approve(f.vault, f.record.id);
  f.vault.extendRetention(f.record.id, 30_000, 'operator', 'POLICY-EXTENSION', 400);
  assert.throws(() => f.vault.extendRetention(f.record.id, 29_999, 'operator', 'SHORTEN', 500), /only be extended/);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 30_000), /STALE/);
  assert.equal(f.vault.listForRescreen(20_000, 1).length, 1);
  const next = f.vault.requestDeletion(f.record.id, decision, 500);
  f.vault.approveDeletion(f.record.id, next.id, 'approver', 600);
  assert.equal(f.vault.purgeExpired(29_999), 0);
  assert.equal(f.vault.purgeExpired(30_000), 1);
});

test('record changes and a replacement request invalidate earlier deletion authorization', t => {
  const f = fixture(t); const request = approve(f.vault, f.record.id);
  f.vault.recordRescreen(f.record.id, { at: 400, decision: 'ALLOW', listVersions: { synthetic: 2 } }, f.vault.get(f.record.id)!);
  assert.equal(f.vault.purgeExpired(20_000), 0);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 20_000), /STALE/);
  const next = f.vault.requestDeletion(f.record.id, decision, 500);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 20_000), /not current/);
  f.vault.recordRescreen(f.record.id, { at: 600, decision: 'ALLOW', listVersions: { synthetic: 3 } }, f.vault.get(f.record.id)!);
  assert.throws(() => f.vault.approveDeletion(f.record.id, next.id, 'approver', 700), /stale/);
});

test('pending issuance, reviews and unreconciled BLOCK cannot be approved or purged', t => {
  const f = fixture(t);
  for (const state of ['pending', 'review', 'blocked'] as const) {
    f.vault.put({ ...f.record, id: state, state });
    assert.throws(() => f.vault.requestDeletion(state, decision, 20_000), /ISSUANCE_PENDING|REVIEW_PENDING|REVOCATION_NOT_RECONCILED/);
  }
  f.vault.recordRescreen(f.record.id, { at: 400, decision: 'BLOCK', listVersions: {} }, f.vault.get(f.record.id)!);
  const job = f.vault.listPendingRevocations()[0];
  f.vault.prepareRevocation(job.id, { hash: 'synthetic-hash', raw: 'synthetic-signed-bytes', chainId: 1, source: 'synthetic-source' });
  assert.throws(() => f.vault.requestDeletion(f.record.id, decision, 20_000), /REVOCATION_PENDING/);
  assert.equal(f.vault.purgeExpired(20_000), 0);
  assert.equal(f.vault.listPendingRevocations()[0].transaction?.raw, 'synthetic-signed-bytes');
  f.vault.finishRevocation(job.id, 500);
  assert.throws(() => f.vault.requestDeletion(f.record.id, decision, 20_000), /disposition/);
  const request = f.vault.requestDeletion(f.record.id, { ...decision, disposition: 'source-revoked' }, 600);
  f.vault.approveDeletion(f.record.id, request.id, 'approver', 700);
  assert.equal(f.vault.purgeExpired(10_000), 1);
  assert.equal(plaintext(f.path).revocations[job.id].walletAddress, f.record.walletAddress); // Deliberately not a global erasure claim.
  assert.equal(plaintext(f.path).revocations[job.id].transaction.raw, '');
});

test('service decisions require local support and erasure never submits a revocation', t => {
  const f = fixture(t);
  assert.throws(() => f.vault.requestDeletion(f.record.id, { ...decision, disposition: 'source-revoked' }, 200), /disposition/);
  assert.throws(() => f.vault.requestDeletion(f.record.id, { ...decision, disposition: 'not-issued' }, 200), /disposition/);
  approve(f.vault, f.record.id);
  assert.equal(f.vault.purgeExpired(10_000), 1);
  assert.deepEqual(f.vault.listPendingRevocations(), []);
  f.vault.put({ ...f.record, id: 'rejected', state: 'rejected' });
  const request = f.vault.requestDeletion('rejected', { ...decision, disposition: 'not-issued' }, 200);
  f.vault.approveDeletion('rejected', request.id, 'approver', 300);
  assert.equal(f.vault.purgeExpired(10_000), 1);
});

test('policy-bound deletion cannot substitute another policy reference or credential disposition', t => {
  const f = fixture(t), now = Date.now();
  const retention = retentionPolicyEvidence(SYNTHETIC_RETENTION_POLICY, {
    customerId: 'synthetic-demo-only', jurisdiction: 'KR', outcome: 'issued', collectedAt: now, decisionAt: now,
  });
  const record = { ...f.record, id: 'policy-bound', createdAt: now, retentionUntil: retention.vaultDeleteAt, retentionPolicy: retention };
  f.vault.put(record);
  assert.throws(() => f.vault.requestDeletion(record.id, { ...decision, policyRef: 'another-policy' }, now + 1), /retained policy snapshot/);
  assert.throws(() => f.vault.requestDeletion(record.id, { ...decision, policyRef: retention.policyId,
    disposition: 'source-revoked' }, now + 1), /retained policy snapshot/);
  const request = f.vault.requestDeletion(record.id, { ...decision, policyRef: retention.policyId }, now + 1);
  f.vault.approveDeletion(record.id, request.id, 'synthetic-approver', now + 2);
  assert.equal(f.vault.purgeExpired(retention.vaultDeleteAt - 1), 0);
  assert.equal(f.vault.purgeExpired(retention.vaultDeleteAt), 1);
});

test('tombstone rejects direct and issuance-journal reinsertion, including legacy erasures', async t => {
  const f = fixture(t); approve(f.vault, f.record.id); f.vault.purgeExpired(10_000);
  const restarted = new EvidenceVault(f.path, KEY);
  assert.throws(() => restarted.put(f.record), /cannot be restored/);
  const sink = issuanceEvidenceSink(() => restarted);
  await assert.rejects(sink.put({ evidenceRecord: f.record } as IssuanceEntry), /cannot be restored/);
  legacy(f.path, f.record, true);
  assert.throws(() => new EvidenceVault(f.path, KEY).put(f.record), /cannot be restored/);
  assert.equal(JSON.stringify(plaintext(f.path)).includes('Synthetic Private Name'), false);
});

test('invalid deadlines and free-text audit fields fail closed; stale instances see current holds', t => {
  const f = fixture(t);
  for (const until of [NaN, Infinity, -1, 99, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => f.vault.put({ ...f.record, id: 'invalid', retentionUntil: until }), /retention/);
  }
  assert.throws(() => f.vault.requestDeletion(f.record.id, { ...decision, policyRef: 'personal name in reason' }, 200), /opaque/);
  assert.throws(() => f.vault.purgeExpired(Infinity), /timestamp/);
  assert.throws(() => f.vault.deletionPreview(NaN), /timestamp/);
  const request = approve(f.vault, f.record.id);
  const stale = new EvidenceVault(f.path, KEY);
  f.vault.placeHold(f.record.id, 'hold-1', 'operator', 'CASE-1', 400);
  assert.throws(() => stale.erase(f.record.id, request.id, 10_000), /LEGAL_HOLD/);
  assert.equal(stale.purgeExpired(10_000), 0);
  legacy(f.path, { ...f.record, retentionUntil: null as unknown as number });
  assert.ok(f.vault.deletionPreview(20_000)[0].blockers.includes('INVALID_RETENTION'));
  assert.throws(() => f.vault.requestDeletion(f.record.id, decision, 20_000), /INVALID_RETENTION/);
});

test('actual admin CLI defaults to preview and requires explicit execution plus prior approval', t => {
  const f = fixture(t);
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'script/vault-admin.ts', ...args], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10_000,
    env: { EVIDENCE_VAULT_PATH: f.path, EVIDENCE_VAULT_KEY: KEY, COMPLIANCE_OPERATOR_ID: 'cli-operator' },
  });
  const original = readFileSync(f.path);
  assert.equal(run('purge').status, 0);
  assert.equal(run('deletion-preview').status, 0);
  assert.deepEqual(readFileSync(f.path), original);
  assert.notEqual(run('erase', f.record.id, 'old free-text reason').status, 0);
  assert.equal(run('purge', '--execute').status, 0);
  assert.ok(f.vault.get(f.record.id));
  const request = approve(f.vault, f.record.id, false);
  assert.notEqual(run('erase', f.record.id, request.id).status, 0);
  const result = run('erase', f.record.id, request.id, '--execute');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /current vault only/);
  assert.equal(f.vault.get(f.record.id), undefined);
});
