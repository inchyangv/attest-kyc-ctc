import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAmlEngine } from './aml.js';
import { EvidenceVault, RescreenConflictError, VaultBusyError, type VaultRecord } from './vault.js';
import { assertRevocationTarget, deliverRevocations, screenDue, type RevocationTransport } from './rescreen.js';

const KEY = 'test-only-rescreen-key-at-least-32-characters';
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-rescreen-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc');
  const record: VaultRecord = {
    id: 'synthetic-request', walletAddress: '0x' + 'ab'.repeat(20), consentVersion: 'test-v1',
    screeningSubject: { fullName: 'Synthetic Test', dateOfBirth: '1990-01-01', nationality: 'KP', residence: 'KP', walletAddress: '0x' + 'ab'.repeat(20) },
    evidenceHash: '0x' + '11'.repeat(32), evidence: {}, state: 'active', createdAt: 1, retentionUntil: 1_000_000,
    rescreens: [], reviews: [],
  };
  const vault = new EvidenceVault(path, KEY);
  vault.put(record);
  return { dir, path, vault, record, engine: new MockAmlEngine({ evidenceKey: KEY }) };
}
const transaction = { hash: 'synthetic-hash', raw: 'synthetic-signed-bytes', chainId: 11155111, source: 'synthetic-source' };
const sender = (overrides: Partial<RevocationTransport> = {}): RevocationTransport => ({
  assertJob: () => {},
  prepare: async () => transaction, receipt: async () => null, broadcast: async () => {}, wait: async () => 'success', ...overrides,
});

test('dry run preserves encrypted bytes, timestamps, active state and due set', async t => {
  const f = fixture(t);
  const before = readFileSync(f.path);
  const preview = await screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: false });
  assert.equal(preview[0].decision, 'BLOCK');
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(f.vault.get(f.record.id)!.state, 'active');
  assert.equal(f.vault.listForRescreen(100, 10).length, 1);
  assert.equal(f.vault.listPendingRevocations().length, 0);
  const missing = join(f.dir, 'not-created', 'vault.enc');
  await screenDue(new EvidenceVault(missing, KEY), f.engine, { now: 100, intervalMs: 10, persist: false });
  assert.equal(existsSync(join(f.dir, 'not-created')), false);
});

test('PM-T20-01 list edition change bypasses the interval and cannot leave a newly listed active wallet unscreened', async t => {
  const f = fixture(t);
  let edition = 1;
  const allow = await f.engine.screen(f.record.screeningSubject);
  f.engine.listVersions = async () => ({ OFAC_SDN: edition });
  f.engine.screen = async () => ({ ...allow, decision: edition === 1 ? 'ALLOW' : 'BLOCK', listVersions: { OFAC_SDN: edition } });

  assert.equal((await screenDue(f.vault, f.engine, { now: 100, intervalMs: 1_000, persist: true })).length, 1);
  assert.equal(f.vault.get(f.record.id)!.state, 'active');
  edition = 2;

  const changed = await screenDue(new EvidenceVault(f.path, KEY), f.engine, { now: 101, intervalMs: 1_000, persist: true });
  assert.equal(changed.length, 1, 'a changed sanctions edition is an immediate trigger, not an interval wait');
  assert.equal(changed[0].decision, 'BLOCK');
  assert.equal(f.vault.get(f.record.id)!.state, 'blocked');
  assert.equal(f.vault.listPendingRevocations().length, 1);
});

test('appendix-B dry then publish sequence retains a deliverable BLOCK even though blocked records leave the due set', async t => {
  const f = fixture(t), before = readFileSync(f.path);
  const preview = await screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: false });
  assert.equal(preview.length, 1); assert.equal(preview[0].decision, 'BLOCK');
  assert.deepEqual(readFileSync(f.path), before);
  await screenDue(new EvidenceVault(f.path, KEY), f.engine, { now: 100, intervalMs: 10, persist: true });
  const publisher = new EvidenceVault(f.path, KEY);
  assert.equal(publisher.listForRescreen(100, 10).length, 0, 'BLOCK is no longer a screening candidate');
  assert.equal(publisher.listPendingRevocations().length, 1, 'the atomic outbox remains independently deliverable');
  assert.deepEqual(await deliverRevocations(publisher, sender(), () => 101), { confirmed: 1, failed: 0, pending: 0 });
});

test('committed BLOCK and outbox survive restart; blocked records remain deliverable', async t => {
  const f = fixture(t);
  await screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
  const restarted = new EvidenceVault(f.path, KEY);
  assert.equal(restarted.get(f.record.id)!.state, 'blocked');
  assert.equal(restarted.listForRescreen(200, 10).length, 0);
  assert.equal(restarted.listPendingRevocations().length, 1);
  assert.deepEqual(await deliverRevocations(restarted, sender(), () => 200), { confirmed: 1, failed: 0, pending: 0 });
  assert.equal(new EvidenceVault(f.path, KEY).listPendingRevocations().length, 0);
});

test('ambiguous broadcast preserves signed transaction; retry does not sign or send a new nonce', async t => {
  const f = fixture(t);
  await screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
  let prepared = 0;
  let broadcasts = 0;
  const failed = sender({
    prepare: async () => { prepared++; return transaction; },
    broadcast: async tx => {
      broadcasts++;
      assert.deepEqual(new EvidenceVault(f.path, KEY).listPendingRevocations()[0].transaction, tx);
      throw new Error('accepted by node but response lost');
    },
    wait: async () => { throw new Error('RPC timeout'); },
  });
  assert.equal((await deliverRevocations(f.vault, failed)).pending, 1);
  const restarted = new EvidenceVault(f.path, KEY);
  assert.equal(restarted.listPendingRevocations()[0].state, 'prepared');
  const recovered = sender({ prepare: failed.prepare, broadcast: failed.broadcast, receipt: async () => 'success' });
  assert.equal((await deliverRevocations(restarted, recovered)).confirmed, 1);
  assert.equal(prepared, 1);
  assert.equal(broadcasts, 1);
});

test('signing error, reverted transaction and receipt-persistence crash remain retryable', async t => {
  const f = fixture(t);
  await screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
  assert.equal((await deliverRevocations(f.vault, sender({ prepare: async () => { throw new Error('signer unavailable'); } }))).pending, 1);
  assert.equal(f.vault.listPendingRevocations()[0].state, 'pending');
  assert.equal((await deliverRevocations(f.vault, sender({ wait: async () => 'reverted' }))).pending, 1);
  assert.equal(f.vault.listPendingRevocations()[0].transaction, undefined);
  const finish = f.vault.finishRevocation.bind(f.vault);
  f.vault.finishRevocation = () => { throw new Error('disk unavailable'); };
  assert.equal((await deliverRevocations(f.vault, sender())).pending, 1);
  f.vault.finishRevocation = finish;
  assert.equal((await deliverRevocations(f.vault, sender({ receipt: async () => 'success', broadcast: async () => assert.fail('must not rebroadcast mined transaction') }))).confirmed, 1);
});

test('legacy blocked records recover once and pending outbox prevents evidence erasure', async t => {
  const f = fixture(t);
  f.vault.put({ ...f.record, id: 'legacy-blocked', state: 'blocked' });
  f.vault.recoverBlockedRevocations(100);
  f.vault.recoverBlockedRevocations(200);
  assert.equal(f.vault.listPendingRevocations().length, 1);
  assert.throws(() => f.vault.requestDeletion('legacy-blocked', { operator: 'requester', policyRef: 'test-policy',
    serviceRef: 'test-decision', disposition: 'source-revoked', automatic: true }, 300), /REVOCATION_PENDING/);
  assert.equal(f.vault.purgeExpired(2_000_000), 0);
  assert.ok(f.vault.get('legacy-blocked'));
  assert.equal(f.vault.listPendingRevocations().length, 1);
  assert.equal(JSON.stringify(f.vault.listPendingRevocations()).includes('Synthetic Test'), false);
});

test('stale vault instances reload under writer lock; failed mutations do not leak state', t => {
  const f = fixture(t);
  const other = new EvidenceVault(f.path, KEY);
  f.vault.put({ ...f.record, id: 'second' });
  other.put({ ...f.record, id: 'third' });
  assert.equal(f.vault.get('third')!.id, 'third');
  assert.equal(other.get('second')!.id, 'second');
  const fd = openSync(`${f.path}.lock`, 'wx');
  try { assert.throws(() => new EvidenceVault(f.path, KEY, { lockWaitMs: 0 }).erase('second', 'must not run'), VaultBusyError); }
  finally { closeSync(fd); unlinkSync(`${f.path}.lock`); }
  assert.ok(f.vault.get('second'));
  assert.throws(() => f.vault.put({ ...f.record, evidenceHash: 'conflict' }), /conflicts/);
  assert.equal(existsSync(`${f.path}.lock`), false);
  assert.equal(f.vault.get(f.record.id)!.evidenceHash, f.record.evidenceHash);
});

test('pending revocation cannot be silently cleared by a human-review mutation', async t => {
  const f = fixture(t);
  await screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
  assert.throws(() => f.vault.decideReview(f.record.id, { at: 200, operator: 'test', outcome: 'cleared', reason: 'test' }, f.vault.reviewSnapshot(f.record.id).revision), /must be reconciled/);
  assert.equal(f.vault.get(f.record.id)!.state, 'blocked');
  assert.equal(f.vault.get(f.record.id)!.reviews.length, 0);
});

test('delayed screening cannot overwrite a concurrent operator decision, including active-to-active review', async t => {
  for (const decision of ['ALLOW', 'BLOCK'] as const) {
    for (const outcome of ['cleared', 'blocked'] as const) {
      const f = fixture(t);
      const result = { ...await f.engine.screen(f.record.screeningSubject), decision };
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      f.engine.screen = async () => { await pending; return result; };
      const running = screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
      const operator = new EvidenceVault(f.path, KEY);
      operator.decideReview(f.record.id, { at: 100, operator: 'synthetic-operator', outcome, reason: 'synthetic-review' }, operator.reviewSnapshot(f.record.id).revision);
      const before = readFileSync(f.path);
      release();
      await assert.rejects(running, RescreenConflictError);
      assert.deepEqual(readFileSync(f.path), before);
      assert.equal(operator.get(f.record.id)!.state, outcome === 'blocked' ? 'blocked' : 'active');
      assert.equal(operator.get(f.record.id)!.rescreens.length, 0);
      assert.equal(operator.listPendingRevocations().length, outcome === 'blocked' ? 1 : 0);
    }
  }
});

test('two delayed screenings at the same timestamp cannot both commit the same snapshot', async t => {
  const f = fixture(t);
  const allow = { ...await f.engine.screen(f.record.screeningSubject), decision: 'ALLOW' as const };
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.engine.screen = async () => { await pending; return allow; };
  const stale = screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
  const current = new EvidenceVault(f.path, KEY);
  const second = new MockAmlEngine({ evidenceKey: KEY });
  second.screen = async () => allow;
  await screenDue(current, second, { now: 100, intervalMs: 10, persist: true });
  const before = readFileSync(f.path);
  release();
  await assert.rejects(stale, RescreenConflictError);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(current.get(f.record.id)!.rescreens.length, 1);
});

test('approved deletion during a delayed screening cannot resurrect the record or create an outbox job', async t => {
  const f = fixture(t);
  const request = f.vault.requestDeletion(f.record.id, { operator: 'requester', policyRef: 'synthetic-policy',
    serviceRef: 'synthetic-service', disposition: 'unchanged', automatic: false }, 20);
  f.vault.approveDeletion(f.record.id, request.id, 'approver', 30);
  const result = await f.engine.screen(f.record.screeningSubject);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  f.engine.screen = async () => { await pending; return result; };
  const running = screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true });
  const operator = new EvidenceVault(f.path, KEY);
  assert.equal(operator.erase(f.record.id, request.id, f.record.retentionUntil), true);
  const before = readFileSync(f.path);
  release();
  await assert.rejects(running, error => error instanceof RescreenConflictError && error.message === 'RESCREEN_RECORD_CHANGED');
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(operator.get(f.record.id), undefined);
  assert.equal(operator.listPendingRevocations().length, 0);
});

test('unrelated writes do not conflict, and a later conflict preserves earlier committed BLOCK delivery', async t => {
  const f = fixture(t);
  f.vault.put({ ...f.record, id: 'second' });
  const result = await f.engine.screen(f.record.screeningSubject);
  const operator = new EvidenceVault(f.path, KEY);
  let calls = 0;
  f.engine.screen = async () => {
    if (++calls === 1) operator.put({ ...f.record, id: 'unrelated' });
    else operator.decideReview('second', { at: 100, operator: 'operator', outcome: 'cleared', reason: 'synthetic' }, operator.reviewSnapshot('second').revision);
    return result;
  };
  await assert.rejects(screenDue(f.vault, f.engine, { now: 100, intervalMs: 10, persist: true }), RescreenConflictError);
  assert.equal(operator.get(f.record.id)!.state, 'blocked');
  assert.equal(operator.get('second')!.state, 'active');
  assert.equal(operator.get('unrelated')!.state, 'active');
  assert.equal(operator.listPendingRevocations().length, 1);
  assert.deepEqual(await deliverRevocations(operator, sender(), () => 200), { confirmed: 1, failed: 0, pending: 0 });
});

test('rescreen requires the original snapshot, validates decision time and cannot activate pending or clear terminal records', t => {
  const f = fixture(t);
  const event = { at: 100, decision: 'ALLOW' as const, listVersions: {} };
  const initial = f.vault.get(f.record.id)!;
  const before = readFileSync(f.path);
  assert.throws(() => f.vault.recordRescreen(f.record.id, event, undefined as unknown as VaultRecord), RescreenConflictError);
  assert.throws(() => f.vault.recordRescreen(f.record.id, event, { ...initial, id: 'wrong' }), RescreenConflictError);
  assert.throws(() => f.vault.recordRescreen(f.record.id, { ...event, at: 0 }, initial), /precedes/);
  assert.throws(() => f.vault.recordRescreen(f.record.id, { ...event, at: NaN }, initial), /timestamp/);
  assert.throws(() => f.vault.recordRescreen(f.record.id, { ...event, decision: 'UNKNOWN' as 'ALLOW' }, initial), /invalid rescreen decision/);
  assert.deepEqual(readFileSync(f.path), before);
  f.vault.decideReview(f.record.id, { at: 200, operator: 'operator', outcome: 'cleared', reason: 'synthetic' }, f.vault.reviewSnapshot(f.record.id).revision);
  assert.throws(() => f.vault.recordRescreen(f.record.id, event, f.vault.get(f.record.id)!), /precedes/);
  for (const state of ['pending', 'blocked', 'rejected'] as const) {
    f.vault.put({ ...f.record, id: state, state });
    const snapshot = f.vault.get(state)!;
    if (state === 'pending') assert.equal(f.vault.recordRescreen(state, event, snapshot).state, 'pending');
    else assert.throws(() => f.vault.recordRescreen(state, event, snapshot), /terminal compliance state/);
    assert.equal(f.vault.get(state)!.state, state);
  }
});

const sourceObservation = { transactionHash: '0x' + 'aa'.repeat(32), chainId: 11155111, source: '0x' + 'cc'.repeat(20), observedAt: 100 };

test('source-confirmed pending records respect screening intervals and clearance cannot manufacture hub acknowledgement', t => {
  const f = fixture(t);
  const id = 'source-pending';
  f.vault.put({ ...f.record, id, state: 'pending', lastScreenedAt: 100 });
  assert.equal(f.vault.listForRescreen(200, 100).some(record => record.id === id), false);
  f.vault.recordSourceConfirmation(id, f.record.evidenceHash, sourceObservation);
  const restarted = new EvidenceVault(f.path, KEY);
  assert.equal(restarted.get(id)!.state, 'pending');
  assert.equal(restarted.listForRescreen(199, 100).some(record => record.id === id), false);
  assert.equal(restarted.listForRescreen(200, 100).some(record => record.id === id), true);
  const apply = (decision: 'ALLOW' | 'REVIEW', at: number) => restarted.recordRescreen(id, { at, decision, listVersions: {} }, restarted.get(id)!);
  assert.equal(apply('ALLOW', 200).state, 'pending');
  assert.equal(apply('REVIEW', 300).state, 'review');
  assert.equal(apply('ALLOW', 400).state, 'pending');
  apply('REVIEW', 500);
  assert.equal(restarted.decideReview(id, { at: 600, outcome: 'cleared', operator: 'operator', reason: 'synthetic' }, restarted.reviewSnapshot(id).revision).state, 'pending');
  apply('REVIEW', 700);
  restarted.recordMaterialization(id, f.record.evidenceHash);
  assert.equal(restarted.get(id)!.state, 'review');
  assert.equal(restarted.get(id)!.sourceIssuance!.hubMaterialized, true);
  assert.equal(apply('ALLOW', 800).state, 'active');
  assert.equal(restarted.listForRescreen(f.record.retentionUntil, 1).some(record => record.id === id), false);
});

test('source observation binds retained evidence and transaction; idempotent replay does not invalidate a screening snapshot', t => {
  const f = fixture(t);
  const before = readFileSync(f.path);
  assert.throws(() => f.vault.recordSourceConfirmation(f.record.id, 'wrong', sourceObservation), /evidence does not match/);
  for (const changes of [{ chainId: 0 }, { source: 'invalid' }, { transactionHash: 'invalid' }, { observedAt: 0 }, { observedAt: NaN }]) {
    assert.throws(() => f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash, { ...sourceObservation, ...changes }), /invalid/);
  }
  assert.deepEqual(readFileSync(f.path), before);
  const unobserved = f.vault.get(f.record.id)!;
  f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash, { ...sourceObservation, hubMaterialized: true });
  assert.equal(f.vault.get(f.record.id)!.sourceIssuance!.hubMaterialized, undefined, 'source acknowledgement cannot inject a hub fact');
  assert.throws(() => f.vault.recordRescreen(f.record.id, { at: 200, decision: 'ALLOW', listVersions: {} }, unobserved), RescreenConflictError);
  const snapshot = f.vault.get(f.record.id)!;
  f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash, { ...sourceObservation, observedAt: 200 });
  assert.deepEqual(f.vault.get(f.record.id), snapshot);
  for (const changes of [{ chainId: 1 }, { source: '0x' + 'dd'.repeat(20) }, { transactionHash: '0x' + 'bb'.repeat(32) }]) {
    assert.throws(() => f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash, { ...sourceObservation, ...changes }), /conflicts/);
  }
  assert.equal(f.vault.recordRescreen(f.record.id, { at: 200, decision: 'BLOCK', listVersions: {} }, snapshot).state, 'blocked');
  f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash, sourceObservation);
  assert.equal(f.vault.get(f.record.id)!.state, 'blocked');
  assert.equal(f.vault.listPendingRevocations().length, 1);
});

test('source-confirmed BLOCK outbox retains its deployment and refuses signing for another target', async t => {
  const f = fixture(t);
  f.vault.recordSourceConfirmation(f.record.id, f.record.evidenceHash, sourceObservation);
  await screenDue(f.vault, f.engine, { now: 200, intervalMs: 10, persist: true });
  const restarted = new EvidenceVault(f.path, KEY);
  const job = restarted.listPendingRevocations()[0];
  assert.deepEqual(job.sourceTarget, { chainId: sourceObservation.chainId, source: sourceObservation.source });
  assertRevocationTarget(job, { chainId: sourceObservation.chainId, source: sourceObservation.source.toUpperCase() });
  let signed = 0;
  const wrong = sender({ prepare: async value => {
    assertRevocationTarget(value, { chainId: 1, source: sourceObservation.source }); signed++; return transaction;
  } });
  assert.equal((await deliverRevocations(restarted, wrong)).pending, 1);
  assert.equal(signed, 0);
  assert.equal(restarted.listPendingRevocations()[0].transaction, undefined);
  assert.throws(() => assertRevocationTarget(job, { chainId: sourceObservation.chainId, source: '0x' + 'dd'.repeat(20) }), /does not match/);
});
