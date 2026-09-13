import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, createDecipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { EPOCH_SOURCE_ABI } from './epoch.js';
import { EpochPublicationJournal, type PublicationIntent } from './epoch-publication-journal.js';

const KEY = 'synthetic-publication-journal-key-at-least-32-characters';
const signer = new ethers.Wallet('0x' + '01'.padStart(64, '0'));
const scope = { chainId: 11155111, source: '0x' + 'ab'.repeat(20), publisher: signer.address };
const abi = new ethers.Interface(EPOCH_SOURCE_ABI);
const intent = (epoch = 1): PublicationIntent => ({
  calldata: abi.encodeFunctionData('publishEpoch', [epoch, ethers.id('root'), 1, 1_800_086_400, 1_800_000_000, ethers.id('snapshot')]),
  sourceCutoff: { blockNumber: 123, blockHash: ethers.id('cutoff') },
  availability: { version: 1, seedHash: 'a'.repeat(64), replicaCount: 2 }, createdAt: 100,
});
const signed = (value = intent(), nonce = 0, overrides: ethers.TransactionRequest = {}) => signer.signTransaction({
  type: 2, chainId: scope.chainId, to: scope.source, nonce, value: 0, data: value.calldata,
  gasLimit: 250_000, maxFeePerGas: 10, maxPriorityFeePerGas: 1, ...overrides,
});
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'proofmark-publication-journal-'));
  const path = join(dir, 'publisher.enc');
  const instances: EpochPublicationJournal[] = [];
  t.after(() => { try { for (const instance of instances) instance.close(); } finally { fs.rmSync(dir, { recursive: true, force: true }); } });
  const open = () => { const j = new EpochPublicationJournal(path, KEY, scope); instances.push(j); return j; };
  return { path, open };
}

test('publisher journal retains exact approved call and signed nonce across reopen; snapshots cannot mutate authority', async t => {
  const f = fixture(t), journal = f.open(), value = intent();
  const begun = journal.begin(value); value.sourceCutoff.blockNumber = 456; value.availability!.seedHash = 'b'.repeat(64);
  assert.equal(journal.snapshot()[0].intent.sourceCutoff.blockNumber, 123);
  assert.equal(journal.snapshot()[0].intent.availability!.seedHash, 'a'.repeat(64));
  const raw = await signed(), prepared = journal.prepare(begun.id, raw);
  assert.equal(prepared.transaction!.hash, ethers.keccak256(raw)); assert.equal(prepared.transaction!.nonce, 0);
  const bytes = fs.readFileSync(f.path);
  assert.equal(bytes.includes(Buffer.from(raw)), false); assert.equal(bytes.includes(Buffer.from('calldata')), false);
  assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
  prepared.transaction!.raw = 'changed'; assert.equal(journal.snapshot()[0].transaction!.raw, raw);
  assert.throws(() => { journal.scope.publisher = scope.source; });
  journal.close(); const reopened = f.open();
  assert.equal(reopened.snapshot()[0].transaction!.raw, raw);
  assert.equal(reopened.begin(intent()).id, begun.id);
  reopened.prepare(begun.id, raw); assert.deepEqual(fs.readFileSync(f.path), bytes, 'exact retries do not rewrite');
  assert.throws(() => reopened.begin(intent(2)), /PUBLICATION_PENDING/);
  assert.throws(() => reopened.abandonUnsigned(begun.id, 200), /PUBLICATION_SIGNED_CANNOT_ABANDON/);
});

test('publisher lease rejects another opener; wrong key, source or chain cannot authenticate existing journal', t => {
  const f = fixture(t), j = f.open(); j.begin(intent());
  assert.throws(() => f.open(), /PUBLICATION_JOURNAL_BUSY/); j.close();
  const bytes = fs.readFileSync(f.path);
  for (const [key, target] of [[KEY + 'wrong', scope], [KEY, { ...scope, chainId: 1 }], [KEY, { ...scope, source: '0x' + 'cd'.repeat(20) }]] as const) {
    assert.throws(() => new EpochPublicationJournal(f.path, key, target), /PUBLICATION_JOURNAL_UNAVAILABLE/);
    assert.deepEqual(fs.readFileSync(f.path), bytes); assert.equal(fs.existsSync(`${f.path}.lock`), false);
  }
  assert.equal(f.open().snapshot().length, 1);
});

test('publisher refuses altered call, target, signer, value, chain and replacement bytes before persistence', async t => {
  const f = fixture(t), j = f.open(), entry = j.begin(intent()), original = fs.readFileSync(f.path);
  for (const overrides of [{ data: intent(2).calldata }, { to: signer.address }, { value: 1 }, { chainId: 1 }]) {
    const raw = await signed(intent(), 0, overrides);
    assert.throws(() => j.prepare(entry.id, raw), /PUBLICATION_TRANSACTION_MISMATCH/);
  }
  const wrong = new ethers.Wallet('0x' + '02'.padStart(64, '0'));
  const wrongRaw = await wrong.signTransaction({ chainId: scope.chainId, to: scope.source, data: intent().calldata, nonce: 0, gasLimit: 250_000, gasPrice: 10 });
  assert.throws(() => j.prepare(entry.id, wrongRaw), /PUBLICATION_TRANSACTION_MISMATCH/);
  assert.deepEqual(fs.readFileSync(f.path), original);
  const raw = await signed(); j.prepare(entry.id, raw);
  const replacement = await signed(intent(), 0, { maxFeePerGas: 11 });
  assert.throws(() => j.prepare(entry.id, replacement), /PUBLICATION_REPLACEMENT_FORBIDDEN/);
  assert.equal(j.snapshot()[0].transaction!.raw, raw);
});

test('confirmation binds original hash and records history before another intent may allocate a different nonce', async t => {
  const f = fixture(t), j = f.open(), first = j.begin(intent()), tx = j.prepare(first.id, await signed()).transaction!;
  const confirmation = { transactionHash: tx.hash, blockNumber: 200, blockHash: ethers.id('confirmed'), status: 1 as const, confirmations: 12, observedAt: 300 };
  for (const invalid of [{ ...confirmation, transactionHash: ethers.id('wrong') }, { ...confirmation, confirmations: 0 }, { ...confirmation, observedAt: 99 }]) {
    assert.throws(() => j.confirm(first.id, invalid), /PUBLICATION_CONFIRMATION_INVALID/);
    assert.throws(() => j.begin(intent(2)), /PUBLICATION_PENDING/);
  }
  j.confirm(first.id, confirmation); const bytes = fs.readFileSync(f.path);
  j.confirm(first.id, confirmation); assert.deepEqual(fs.readFileSync(f.path), bytes);
  assert.throws(() => j.confirm(first.id, { ...confirmation, status: 0 }), /PUBLICATION_CONFIRMATION_CONFLICT/);
  const second = j.begin(intent(2));
  const reused = await signed(intent(2)); assert.throws(() => j.prepare(second.id, reused), /PUBLICATION_NONCE_REUSED/);
  j.prepare(second.id, await signed(intent(2), 1));
  j.close(); assert.equal(f.open().snapshot().length, 2);
});

test('unsigned cancellation is explicit, monotonic and cannot be signed afterward; unrelated calls are refused', t => {
  const f = fixture(t), j = f.open();
  assert.throws(() => j.begin({ ...intent(), calldata: '0x12345678' }), /PUBLICATION_INTENT_INVALID/);
  assert.throws(() => j.begin({ ...intent(), calldata: intent().calldata + '00' }), /PUBLICATION_INTENT_INVALID/);
  assert.throws(() => j.begin({ ...intent(), availability: { version: 1, seedHash: 'a'.repeat(64), replicaCount: 1 } }), /PUBLICATION_INTENT_INVALID/);
  const first = j.begin(intent());
  assert.throws(() => j.abandonUnsigned(first.id, 99), /PUBLICATION_ABANDONMENT_INVALID/);
  j.abandonUnsigned(first.id, 200);
  assert.throws(() => j.prepare(first.id, '0x'), /PUBLICATION_ABANDONED/);
  assert.equal(j.abandonUnsigned(first.id, 300).abandonment!.at, 200);
  assert.ok(j.begin(intent(2)));
});

test('post-rename fsync failure never returns prepared bytes and retains a cross-instance recovery fence', async t => {
  const f = fixture(t), j = f.open(), entry = j.begin(intent()), raw = await signed(), sync = fs.fsyncSync;
  const hook = t.mock.method(fs, 'fsyncSync', (fd: number) => { if (fs.fstatSync(fd).isDirectory()) throw new Error('PRIVATE_DISK_PATH'); sync(fd); });
  try { assert.throws(() => j.prepare(entry.id, raw), /PUBLICATION_WRITE_UNCONFIRMED/); }
  finally { hook.mock.restore(); }
  assert.throws(() => j.snapshot(), /PUBLICATION_WRITE_UNCONFIRMED/);
  j.close(); assert.equal(fs.existsSync(`${f.path}.lock`), true);
  assert.throws(() => f.open(), /PUBLICATION_JOURNAL_BUSY/);
  // Inspection only: authenticated post-rename ciphertext contains the exact transaction.
  // No force-unlock or alternate writer is used by the production API.
  const envelope = JSON.parse(fs.readFileSync(f.path, 'utf8'));
  assert.equal(envelope.version, 1); assert.equal(typeof envelope.ciphertext, 'string');
  const key = createHash('sha256').update('proofmark-epoch-key-v1\0').update(KEY).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(Buffer.from(`proofmark-epoch-publication-v1\0${JSON.stringify({ ...scope, publisher: scope.publisher.toLowerCase() })}`));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const stored = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  assert.equal(stored.entries[0].transaction.raw, raw, 'renamed bytes exist but were never acknowledged as durable');
});
