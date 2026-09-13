import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { advanceIssuance, type IssuanceEvidenceSink, type IssuanceTransport, type IssuanceReceipt } from './issuance-delivery.js';
import { IssuanceJournalError, type IssuanceJournal, type IssuanceEntry, type JournalSnapshot } from './issuance-journal.js';
import { packAttrs } from './attrs.js';
import fs, { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceVault, VaultWriteError } from './vault.js';
import { issuanceEvidenceSink } from './issuance-evidence.js';
import { MockAmlEngine } from './aml.js';
import { screenDue } from './rescreen.js';

/** Test double for orchestration fault injection. Production atomicity is separately tested in Redis. */
class Journal implements IssuanceJournal {
  data = new Map<string, JournalSnapshot>(); owners = new Map<string, string>(); gate: string | null = null;
  saveCount = 0; failAt = 0; commitThenFail = false;
  async create(entry: IssuanceEntry) { if (!this.data.has(entry.requestId)) this.data.set(entry.requestId, { revision: 1, entry: structuredClone(entry) }); return (await this.get(entry.requestId))!; }
  async get(id: string) { return structuredClone(this.data.get(id) ?? null); }
  async acquire(id: string, owner: string) {
    const snapshot = (await this.get(id))!;
    if (this.owners.has(id)) throw new IssuanceJournalError('REQUEST_BUSY');
    if (['prepared', 'submitted'].includes(snapshot.entry.phase)) {
      if (this.gate && this.gate !== id) throw new IssuanceJournalError('SIGNER_BUSY'); this.gate = id;
    }
    this.owners.set(id, owner); return snapshot;
  }
  async save(snapshot: JournalSnapshot, owner: string) {
    this.saveCount++;
    if (this.owners.get(snapshot.entry.requestId) !== owner) throw new IssuanceJournalError('LEASE_LOST');
    if (this.data.get(snapshot.entry.requestId)!.revision !== snapshot.revision) throw new IssuanceJournalError('REVISION_CONFLICT');
    if (this.saveCount === this.failAt && !this.commitThenFail) throw new IssuanceJournalError('JOURNAL_UNAVAILABLE');
    const saved = structuredClone({ revision: snapshot.revision + 1, entry: snapshot.entry });
    this.data.set(snapshot.entry.requestId, saved);
    if (!['prepared', 'submitted'].includes(snapshot.entry.phase) && this.gate === snapshot.entry.requestId) this.gate = null;
    if (this.saveCount === this.failAt) throw new IssuanceJournalError('JOURNAL_UNAVAILABLE');
    return structuredClone(saved);
  }
  async release(id: string, owner: string) { if (this.owners.get(id) === owner) this.owners.delete(id); }
  async pending() { return [...this.data.keys()]; }
}
function entry(id = 1): IssuanceEntry {
  return { version: 1, requestId: ethers.zeroPadValue(ethers.toBeHex(id), 32), wallet: '0x' + 'ab'.repeat(20),
    fingerprint: 'immutable-fingerprint', consentVersion: 'synthetic-consent', createdAt: 100, prepareUntil: 1_000_000,
    phase: 'prepared', target: { chainId: 11155111, hubChainId: 102031, source: '0x' + '11'.repeat(20), asc: '0x' + '22'.repeat(20), issuer: '0x' + '33'.repeat(20) },
    outcome: { status: 'ISSUED', attrs: packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410, methods: 63, issuedAt: 1, expiry: 100_000, epoch: 0 }),
      claimsRoot: ethers.id('original-salted-claims'), evidenceHash: ethers.id('original-timestamped-evidence'), methods: 63, methodNames: [], expiry: 100_000, regime: 2, claims: [], evidence: [] },
    assurance: 3, evidenceStored: false, revertedTransactions: [] };
}
function fixture() {
  const journal = new Journal(); const prepared = entry();
  const calls = { put: 0, sourceConfirmed: 0, activated: 0, prepare: 0, broadcast: 0, receipt: 0 };
  let receipt: IssuanceReceipt = { status: 'pending' }; let mine = true; let hub = false;
  const confirmation = { blockNumber: 100, blockHash: ethers.id('canonical-block'), transactionIndex: 2, confirmedAt: 200 };
  const evidence: IssuanceEvidenceSink = {
    put: async () => { calls.put++; }, assertMayBroadcast: async () => {}, materialized: async () => { calls.activated++; },
    sourceConfirmed: async () => { calls.sourceConfirmed++; },
  };
  const transport: IssuanceTransport = {
    assertTarget: async () => {}, processed: async () => false,
    prepare: async value => { calls.prepare++; return { hash: ethers.id(`tx-${calls.prepare}`), raw: `signed-${calls.prepare}`, nonce: calls.prepare - 1,
      chainId: value.target.chainId, source: value.target.source, issuer: value.target.issuer }; },
    broadcast: async () => { calls.broadcast++; if (mine) receipt = { status: 'success', confirmation }; },
    receipt: async () => { calls.receipt++; return receipt; }, materialized: async () => hub,
  };
  return { journal, prepared, calls, evidence, transport, confirmation,
    setReceipt: (value: IssuanceReceipt) => { receipt = value; }, setMine: (value: boolean) => { mine = value; }, setHub: (value: boolean) => { hub = value; },
    run: (retryFailed = false, now = 300) => advanceIssuance(journal, prepared.requestId, transport, evidence, { retryFailed, now: () => now }),
  };
}

test('same immutable evidence survives source confirmation and later hub materialization', async () => {
  const f = fixture(); await f.journal.create(f.prepared);
  const source = await f.run(); assert.equal(source.entry.phase, 'source-confirmed'); assert.equal(f.calls.activated, 0);
  assert.equal(f.calls.put, 1); assert.equal(f.calls.prepare, 1);
  f.setHub(true); const hub = await f.run(); assert.equal(hub.entry.phase, 'materialized'); assert.equal(f.calls.activated, 1);
  assert.deepEqual(hub.entry.outcome, f.prepared.outcome); assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 1);
  const revision = hub.revision; assert.equal((await f.run()).revision, revision, 'completed replay does not extend retention');
});

test('issuer gas is reserved before durable send and reconciled once a receipt is final', async () => {
  const f = fixture();
  const prepare = f.transport.prepare;
  f.transport.prepare = async value => ({ ...await prepare(value), gasLimit: '80000' });
  let receipt: IssuanceReceipt = { status: 'pending' };
  f.transport.receipt = async () => receipt;
  f.transport.broadcast = async () => { f.calls.broadcast++; receipt = { status: 'success', confirmation: { ...f.confirmation, gasUsed: '50000' } }; };
  const calls = { reserve: 0, reconcile: 0 };
  const budget = {
    reserve: async (input: { requestId: string; issuer: string; gasLimit: bigint }) => {
      calls.reserve++; assert.equal(input.gasLimit, 80000n); assert.equal(input.issuer, f.prepared.target.issuer);
      return { reservedGas: 80000n, transactionCount: 1 };
    },
    reconcile: async (input: { requestId: string; issuer: string; gasUsed: bigint }) => {
      calls.reconcile++; assert.equal(input.gasUsed, 50000n); assert.equal(input.issuer, f.prepared.target.issuer);
    },
  };
  await f.journal.create(f.prepared);
  const result = await advanceIssuance(f.journal, f.prepared.requestId, f.transport, f.evidence, { budget, now: () => 300 });
  assert.equal(result.entry.phase, 'source-confirmed'); assert.equal(calls.reserve, 1); assert.equal(calls.reconcile, 1);
  assert.equal(f.calls.broadcast, 1);
});

test('evidence or signing failure leaves no transaction and no active record; retry is allowed', async () => {
  for (const step of ['evidence', 'signing']) {
    const f = fixture(); await f.journal.create(f.prepared);
    const put = f.evidence.put; const prepare = f.transport.prepare;
    if (step === 'evidence') f.evidence.put = async () => { throw new Error('disk failure'); };
    else f.transport.prepare = async () => { throw new Error('insufficient funds'); };
    const failed = await f.run(); assert.equal(failed.entry.phase, 'prepared'); assert.equal(failed.entry.transaction, undefined);
    assert.equal(f.calls.broadcast, 0); assert.equal(f.calls.activated, 0);
    f.evidence.put = put; f.transport.prepare = prepare;
    assert.equal((await f.run()).entry.phase, 'source-confirmed');
  }
});

test('signed-save failure forbids broadcast; remotely committed save resumes the exact bytes', async () => {
  for (const committed of [false, true]) {
    const f = fixture(); await f.journal.create(f.prepared); f.journal.failAt = 2; f.journal.commitThenFail = committed;
    await assert.rejects(f.run(), /JOURNAL_UNAVAILABLE/); assert.equal(f.calls.broadcast, 0);
    const stored = await f.journal.get(f.prepared.requestId);
    assert.equal(!!stored!.entry.transaction, committed);
    f.journal.failAt = 0;
    const recovered = await f.run(); assert.equal(recovered.entry.phase, 'source-confirmed');
    assert.equal(f.calls.prepare, committed ? 1 : 2);
    if (committed) assert.equal(recovered.entry.transaction!.raw, stored!.entry.transaction!.raw);
  }
});

test('lost broadcast response and lost confirmation save recover without a second signature', async () => {
  const f = fixture(); await f.journal.create(f.prepared);
  f.transport.broadcast = async () => { f.calls.broadcast++; f.setReceipt({ status: 'success', confirmation: f.confirmation }); throw new Error('response lost'); };
  f.journal.failAt = 5;
  await assert.rejects(f.run(), /JOURNAL_UNAVAILABLE/);
  f.journal.failAt = 0;
  const recovered = await f.run(); assert.equal(recovered.entry.phase, 'source-confirmed');
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 1); assert.equal(f.calls.activated, 0);
});

test('unknown pending nonce holds the gate across requests and resumes; confirmed revert needs explicit retry', async () => {
  const f = fixture(); await f.journal.create(f.prepared); await f.journal.create(entry(2)); f.setMine(false);
  assert.equal((await f.run()).entry.phase, 'submitted');
  await assert.rejects(advanceIssuance(f.journal, entry(2).requestId, f.transport, f.evidence), /SIGNER_BUSY/);
  f.setReceipt({ status: 'reverted', confirmation: f.confirmation });
  assert.equal((await f.run()).entry.phase, 'failed'); assert.equal(f.journal.gate, null);
  assert.equal((await f.run()).entry.phase, 'failed'); assert.equal(f.calls.prepare, 1);
  f.setReceipt({ status: 'pending' }); f.setMine(true);
  const retried = await f.run(true); assert.equal(retried.entry.phase, 'source-confirmed');
  assert.equal(f.calls.prepare, 2); assert.equal(retried.entry.revertedTransactions.length, 1);
  assert.deepEqual(retried.entry.outcome, f.prepared.outcome);
});

test('expired never-signed preparation fails without dependencies, and used request is not falsely recovered', async () => {
  const f = fixture(); await f.journal.create(f.prepared);
  f.evidence.put = async () => { throw new Error('unavailable'); };
  assert.equal((await f.run(false, f.prepared.prepareUntil)).entry.lastError, 'PREPARATION_EXPIRED');
  assert.equal(f.journal.gate, null); assert.equal(f.calls.prepare, 0);
  const g = fixture(); await g.journal.create(g.prepared); g.transport.processed = async () => true;
  assert.equal((await g.run()).entry.lastError, 'REQUEST_ALREADY_USED_UNRECONCILED'); assert.equal(g.calls.prepare, 0);
});

test('PM-T27-01 a prepared issuance cannot sign or broadcast after the active sanctions snapshot changes', async () => {
  const f = fixture();
  const preparedSnapshot = 'a'.repeat(64);
  (f.prepared.outcome as typeof f.prepared.outcome & { screeningSnapshotId: string }).screeningSnapshotId = preparedSnapshot;
  await f.journal.create(f.prepared);
  const sink = issuanceEvidenceSink(() => null, async entry => {
    const snapshot = (entry.outcome as typeof entry.outcome & { screeningSnapshotId?: string }).screeningSnapshotId;
    if (snapshot !== 'b'.repeat(64)) throw new IssuanceJournalError('SANCTIONS_SNAPSHOT_CHANGED');
  });

  await assert.rejects(
    advanceIssuance(f.journal, f.prepared.requestId, f.transport, sink, { now: () => 300 }),
    error => error instanceof IssuanceJournalError && error.code === 'SANCTIONS_SNAPSHOT_CHANGED',
  );
  const result = (await f.journal.get(f.prepared.requestId))!;
  assert.equal(result.entry.phase, 'prepared');
  assert.equal(result.entry.transaction, undefined);
  assert.equal(f.calls.prepare, 0);
  assert.equal(f.calls.broadcast, 0);
});

test('lost request lease after signing cannot send a stale signature', async () => {
  const f = fixture(); await f.journal.create(f.prepared);
  const prepare = f.transport.prepare;
  f.transport.prepare = async value => { const tx = await prepare(value); f.journal.owners.clear(); return tx; };
  await assert.rejects(f.run(), /LEASE_LOST/); assert.equal(f.calls.broadcast, 0);
});

test('source observation failure is recovered by the same confirmed transaction before advancing the journal', async () => {
  for (const committed of [false, true]) {
    const f = fixture(); await f.journal.create(f.prepared);
    let observed = false;
    f.evidence.sourceConfirmed = async (_, confirmation) => {
      assert.deepEqual(confirmation, f.confirmation);
      if (committed) observed = true;
      throw new Error('synthetic vault write response failure');
    };
    const failed = await f.run();
    assert.equal(failed.entry.phase, 'submitted');
    assert.equal(failed.entry.lastError, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(observed, committed);
    assert.equal(f.calls.activated, 0);
    const hash = failed.entry.transaction!.hash;
    f.evidence.sourceConfirmed = async () => { observed = true; };
    const recovered = await f.run();
    assert.equal(recovered.entry.phase, 'source-confirmed');
    assert.equal(recovered.entry.transaction!.hash, hash);
    assert.equal(observed, true);
    assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 1);
  }
});

test('materialization evidence failure stays recoverable until vault activation is durable', async () => {
  for (const committed of [false, true]) {
    const f = fixture(); await f.journal.create(f.prepared);
    assert.equal((await f.run()).entry.phase, 'source-confirmed');
    f.setHub(true);
    let active = false; let attempts = 0;
    f.evidence.materialized = async () => {
      attempts++;
      if (committed) active = true;
      if (attempts === 1) throw new Error('synthetic vault activation response failure');
      active = true;
    };
    const interrupted = await f.run();
    assert.equal(interrupted.entry.phase, 'source-confirmed');
    assert.equal(interrupted.entry.lastError, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(active, committed);
    assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 1);
    const recovered = await f.run();
    assert.equal(recovered.entry.phase, 'materialized');
    assert.equal(recovered.entry.lastError, undefined);
    assert.equal(active, true); assert.equal(attempts, 2);
    assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 1);
  }
});

test('pending or reverted receipts never authorize a source observation', async () => {
  const f = fixture(); await f.journal.create(f.prepared); f.setMine(false);
  assert.equal((await f.run()).entry.phase, 'submitted');
  assert.equal(f.calls.sourceConfirmed, 0);
  f.setReceipt({ status: 'reverted', confirmation: f.confirmation });
  assert.equal((await f.run()).entry.phase, 'failed');
  assert.equal(f.calls.sourceConfirmed, 0);
});

test('retained source-confirmed pending issuance is rescreened and a BLOCK survives late materialization', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-source-rescreen-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = 'synthetic-source-rescreen-key-at-least-32-characters';
  const vault = new EvidenceVault(join(dir, 'vault.enc'), key);
  const f = fixture();
  f.prepared.evidenceRecord = {
    id: f.prepared.requestId, walletAddress: f.prepared.wallet, consentVersion: 'synthetic',
    screeningSubject: { fullName: 'Synthetic Test', nationality: 'KP', residence: 'KP', dateOfBirth: '1990-01-01', walletAddress: f.prepared.wallet },
    evidenceHash: f.prepared.outcome.evidenceHash, evidence: [], state: 'pending', createdAt: 100,
    retentionUntil: Date.now() + 100_000, lastScreenedAt: 100, reviews: [], rescreens: [],
  };
  await f.journal.create(f.prepared);
  const sink = issuanceEvidenceSink(() => vault);
  const run = () => advanceIssuance(f.journal, f.prepared.requestId, f.transport, sink, { now: () => 300 });
  assert.equal((await run()).entry.phase, 'source-confirmed');
  const record = vault.get(f.prepared.requestId)!;
  assert.equal(record.state, 'pending');
  assert.equal(record.sourceIssuance!.transactionHash, (await f.journal.get(record.id))!.entry.transaction!.hash);
  assert.equal(record.sourceIssuance!.hubMaterialized, undefined);
  assert.equal(vault.listForRescreen(300, 100).length, 1);
  await screenDue(vault, new MockAmlEngine({ evidenceKey: key }), { now: 300, intervalMs: 100, persist: true });
  assert.equal(vault.get(record.id)!.state, 'blocked');
  assert.equal(vault.listPendingRevocations().length, 1);
  f.setHub(true);
  assert.equal((await run()).entry.phase, 'materialized');
  assert.equal(vault.get(record.id)!.state, 'blocked');
  assert.equal(vault.get(record.id)!.sourceIssuance!.hubMaterialized, true);
  assert.equal(vault.listPendingRevocations().length, 1);
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 1);
});

test('required retained vault cannot disappear during source or hub acknowledgement', async () => {
  const value = entry(); value.evidenceRecord = {} as NonNullable<IssuanceEntry['evidenceRecord']>;
  const sink = issuanceEvidenceSink(() => null);
  const confirmation = { blockNumber: 1, blockHash: ethers.id('block'), transactionIndex: 0, confirmedAt: 200 };
  await assert.rejects(sink.sourceConfirmed(value, confirmation), /EVIDENCE_VAULT_UNAVAILABLE/);
  await assert.rejects(sink.materialized(value), /EVIDENCE_VAULT_UNAVAILABLE/);
  delete value.evidenceRecord;
  await sink.sourceConfirmed(value, confirmation); await sink.materialized(value); // Explicit no-vault sandbox only.
});

function retainedFixture(t: { after: (fn: () => void) => void }) {
  const f = fixture(), dir = mkdtempSync(join(tmpdir(), 'proofmark-issuance-fence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'vault.enc'), key = 'synthetic-issuance-fence-key-at-least-32-characters';
  const vault = new EvidenceVault(path, key);
  f.prepared.evidenceRecord = {
    id: f.prepared.requestId, walletAddress: f.prepared.wallet, consentVersion: 'synthetic',
    screeningSubject: { fullName: 'Synthetic Test', nationality: 'KR', residence: 'KR', dateOfBirth: '1990-01-01', walletAddress: f.prepared.wallet },
    evidenceHash: f.prepared.outcome.evidenceHash, evidence: [], state: 'pending', createdAt: 100,
    retentionUntil: Date.now() + 100_000, lastScreenedAt: 100, reviews: [], rescreens: [],
  };
  vault.put(f.prepared.evidenceRecord); f.prepared.evidenceStored = true;
  return { ...f, path, key, vault };
}

test('unconfirmed vault writes fence already-stored issuance evidence before signing or rebroadcast, including reopened writers', async t => {
  for (const signed of [false, true]) for (const reopen of [false, true]) {
    const f = retainedFixture(t);
    if (signed) f.prepared.transaction = await f.transport.prepare(f.prepared);
    await f.journal.create(f.prepared);
    const sync = fs.fsyncSync;
    const hook = t.mock.method(fs, 'fsyncSync', (fd: number) => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('PRIVATE_DISK_DIAGNOSTIC');
      return sync(fd);
    });
    try {
      assert.throws(() => f.vault.put({ ...f.prepared.evidenceRecord!, id: 'unrelated-record' }), VaultWriteError);
    } finally { hook.mock.restore(); }
    const vault = reopen ? new EvidenceVault(f.path, f.key) : f.vault;
    const result = await advanceIssuance(f.journal, f.prepared.requestId, f.transport, issuanceEvidenceSink(() => vault), { now: () => 300 });
    assert.equal(result.entry.lastError, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(result.entry.phase, 'prepared');
    assert.deepEqual(result.entry.transaction, f.prepared.transaction);
    assert.equal(f.calls.prepare, signed ? 1 : 0); assert.equal(f.calls.broadcast, 0);
    assert.equal(f.journal.gate, f.prepared.requestId);
    assert.equal(existsSync(`${f.path}.lock`), true);
  }
});

test('vault fence appearing during durable broadcast-intent save prevents sending and preserves the signed nonce gate', async t => {
  const f = retainedFixture(t); await f.journal.create(f.prepared);
  const save = f.journal.save.bind(f.journal);
  f.journal.save = async (snapshot, owner) => {
    const result = await save(snapshot, owner);
    if (snapshot.entry.phase === 'submitted' && !existsSync(`${f.path}.lock`)) {
      writeFileSync(`${f.path}.lock`, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    }
    return result;
  };
  const result = await advanceIssuance(f.journal, f.prepared.requestId, f.transport, issuanceEvidenceSink(() => f.vault), { now: () => 300 });
  assert.equal(result.entry.lastError, 'DEPENDENCY_UNAVAILABLE');
  assert.equal(result.entry.phase, 'submitted'); assert.ok(result.entry.transaction);
  assert.equal(f.calls.prepare, 1); assert.equal(f.calls.broadcast, 0);
  assert.equal(f.journal.gate, f.prepared.requestId);
  assert.equal(result.entry.broadcastAcceptedAt, undefined);
});
