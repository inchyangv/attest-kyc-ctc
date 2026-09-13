import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { EvidenceVault } from './vault.js';
import { normalizeRevocationObservation, revocationObservation, type RevocationObservation } from './revocation-observation.js';

function observation(): RevocationObservation {
  return { version: 1, operator: 'synthetic-operator', observedAt: 1000, state: 'ENFORCED',
    config: { source: '0x' + '11'.repeat(20), asc: '0x' + '22'.repeat(20), registry: '0x' + '33'.repeat(20), expectedRevoker: '0x' + '44'.repeat(20),
      sourceCodeHash: ethers.id('source'), ascCodeHash: ethers.id('asc'), registryCodeHash: ethers.id('registry'), policyIds: [1, 2], confirmations: 6 },
    source: { transactionHash: ethers.id('transaction'), blockNumber: 10, blockHash: ethers.id('source-block'), transactionIndex: 2, receiptLogIndex: 3, confirmations: 6,
      head: { blockNumber: 15, blockHash: ethers.id('source-head'), timestamp: 1000 } },
    hub: { blockNumber: 20, blockHash: ethers.id('hub-block'), timestamp: 1000, tombstone: true,
      cursor: { height: '10', transactionIndex: '2', receiptLogIndex: '3' }, policies: [{ id: 1, verified: false }, { id: 2, verified: false }] } };
}
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-observation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), key = 'synthetic-observation-vault-key-at-least-32-characters';
  const vault = new EvidenceVault(path, key), o = observation();
  vault.put({ id: 'synthetic-record', walletAddress: '0x' + '55'.repeat(20), consentVersion: 'synthetic',
    screeningSubject: { fullName: 'SYNTHETIC-PRIVATE-NAME', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: '0x' + '55'.repeat(20) },
    evidenceHash: ethers.id('evidence'), evidence: [], state: 'blocked', createdAt: 1, retentionUntil: 2000000, reviews: [], rescreens: [] });
  vault.recoverBlockedRevocations(2);
  const id = vault.listPendingRevocations()[0].id;
  vault.prepareRevocation(id, { hash: o.source.transactionHash, chainId: 11155111, source: o.config.source, raw: 'synthetic-signed-bytes' });
  vault.finishRevocation(id, 3);
  return { path, key, vault, id, o, record: vault.get('synthetic-record')! };
}

test('historical enforcement and later supersession survive restart without changing compliance or source-delivery state', t => {
  const f = fixture(t);
  f.vault.recordRevocationObservation(f.id, f.vault.getRevocation(f.id)!, f.o, 1000000);
  const reopened = new EvidenceVault(f.path, f.key);
  assert.equal(reopened.getRevocation(f.id)!.observations![0].observation.state, 'ENFORCED');
  const next = structuredClone(f.o); next.observedAt++; next.hub.timestamp++; next.hub.blockNumber++;
  next.hub.blockHash = ethers.id('later-hub'); next.hub.cursor.height = '11'; next.state = 'SUPERSEDED';
  reopened.recordRevocationObservation(f.id, reopened.getRevocation(f.id)!, next, 1001000);
  const job = f.vault.getRevocation(f.id)!;
  assert.deepEqual(job.observations!.map(entry => entry.observation.state), ['ENFORCED', 'SUPERSEDED']);
  assert.equal(job.state, 'confirmed'); assert.equal(job.confirmedAt, 3); assert.equal(job.transaction!.raw, '');
  assert.deepEqual(f.vault.get('synthetic-record'), f.record);
  assert.equal(f.vault.listPendingRevocations().length, 0);
  assert.equal(readFileSync(f.path, 'utf8').includes('SYNTHETIC-PRIVATE-NAME'), false);
});

test('stale job snapshots reject concurrent observations; exact replay does not append duplicate history', t => {
  const f = fixture(t), snapshot = f.vault.getRevocation(f.id)!;
  f.vault.recordRevocationObservation(f.id, snapshot, f.o, 1000000);
  const bytes = readFileSync(f.path);
  assert.throws(() => f.vault.recordRevocationObservation(f.id, snapshot, f.o, 1000001), /REVOCATION_JOB_CHANGED/);
  assert.deepEqual(readFileSync(f.path), bytes);
  f.vault.recordRevocationObservation(f.id, f.vault.getRevocation(f.id)!, f.o, 1000001);
  assert.equal(f.vault.getRevocation(f.id)!.observations!.length, 1);
  assert.equal(f.vault.getRevocation(f.id)!.observations![0].recordedAt, 1000000);
});

test('wrong transactions, stale/backdated observations and inconsistent positive claims cannot be persisted', t => {
  const f = fixture(t), snapshot = f.vault.getRevocation(f.id)!;
  const wrong = structuredClone(f.o); wrong.source.transactionHash = ethers.id('other');
  assert.throws(() => f.vault.recordRevocationObservation(f.id, snapshot, wrong, 1000000), /TARGET_MISMATCH/);
  assert.throws(() => f.vault.recordRevocationObservation(f.id, snapshot, f.o, 999999), /STALE/);
  assert.throws(() => f.vault.recordRevocationObservation(f.id, snapshot, f.o, 1300001), /STALE/);
  const lie = structuredClone(f.o); lie.hub.policies[1].verified = true;
  assert.throws(() => f.vault.recordRevocationObservation(f.id, snapshot, lie, 1000000), /INVALID/);
  f.vault.recordRevocationObservation(f.id, snapshot, f.o, 1000100);
  const old = structuredClone(f.o); old.observedAt--;
  assert.throws(() => f.vault.recordRevocationObservation(f.id, f.vault.getRevocation(f.id)!, old, 1000200), /BACKDATED/);
  assert.equal(f.vault.getRevocation(f.id)!.observations!.length, 1);
});

test('schema projects approved metadata only and preserves negative full observations without claiming success', () => {
  const o = observation();
  const projected = normalizeRevocationObservation(Object.assign(o, { privateDiagnostic: 'DO-NOT-PERSIST' }));
  assert.equal(JSON.stringify(projected).includes('DO-NOT-PERSIST'), false);
  for (const change of [(v: RevocationObservation) => { v.operator = undefined as unknown as string; },
    (v: RevocationObservation) => { v.operator = 'private free text'; },
    (v: RevocationObservation) => { v.hub.cursor.height = '-1'; },
    (v: RevocationObservation) => { v.config.policyIds = [1, 1]; },
    (v: RevocationObservation) => { v.hub.policies[0].verified = 'false' as unknown as boolean; },
    (v: RevocationObservation) => { v.source.confirmations = 5; },
    (v: RevocationObservation) => { v.source.head.blockNumber = 16; },
    (v: RevocationObservation) => { v.source.head.timestamp = 699; },
    (v: RevocationObservation) => { v.config.source = ethers.ZeroAddress; }]) {
    const value = observation(); change(value); assert.throws(() => normalizeRevocationObservation(value));
  }
  const waiting = observation(); waiting.hub.cursor.height = '9'; waiting.state = 'AWAITING_HUB';
  assert.equal(normalizeRevocationObservation(waiting).state, 'AWAITING_HUB');
  const inconsistent = observation(); inconsistent.hub.tombstone = false; inconsistent.state = 'INCONSISTENT';
  assert.equal(normalizeRevocationObservation(inconsistent).state, 'INCONSISTENT');
  assert.throws(() => revocationObservation({ state: 'SOURCE_PENDING', enforced: false, transactionHash: o.source.transactionHash }, o.config, o.operator), /INCOMPLETE/);
});

test('history CLI is explicitly historical, does not need RPC settings and leaves the vault unchanged', t => {
  const f = fixture(t); f.vault.recordRevocationObservation(f.id, f.vault.getRevocation(f.id)!, f.o, 1000000);
  const bytes = readFileSync(f.path);
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'script/check-revocation.ts', f.id, '--history'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: f.path, EVIDENCE_VAULT_KEY: f.key,
      SOURCE_CHAIN_RPC_URL: 'invalid-no-network', CREDITCOIN_RPC_URL: 'invalid-no-network' },
  });
  assert.equal(child.status, 0); assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout.split('\n')[0]);
  assert.equal(result.historicalOnly, true); assert.equal(result.currentEnforcement, 'NOT_CHECKED');
  assert.equal(result.observations[0].observation.state, 'ENFORCED');
  assert.equal(child.stdout.includes('SYNTHETIC-PRIVATE-NAME'), false); assert.equal(child.stdout.includes(f.key), false);
  assert.deepEqual(readFileSync(f.path), bytes);
  const denied = spawnSync(process.execPath, ['--import', 'tsx', 'script/check-revocation.ts', f.id, '--record'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, EVIDENCE_VAULT_PATH: f.path,
      EVIDENCE_VAULT_KEY: f.key, COMPLIANCE_OPERATOR_ID: '' },
  });
  assert.equal(denied.status, 1); assert.equal(denied.stderr.trim(), 'MISSING_CHECK_CONFIGURATION');
  assert.deepEqual(readFileSync(f.path), bytes);
});

test('recorded observations invalidate earlier deletion snapshots and never authorize deletion themselves', t => {
  const f = fixture(t);
  const request = f.vault.requestDeletion(f.record.id, { operator: 'requester', policyRef: 'synthetic-policy', serviceRef: 'synthetic-service',
    disposition: 'source-revoked', automatic: false }, 100);
  f.vault.approveDeletion(f.record.id, request.id, 'approver', 200);
  f.vault.recordRevocationObservation(f.id, f.vault.getRevocation(f.id)!, f.o, 1000000);
  assert.throws(() => f.vault.erase(f.record.id, request.id, 2000000), /STALE/);
  assert.equal(f.vault.purgeExpired(2000000), 0);
  assert.ok(f.vault.get(f.record.id));
});
