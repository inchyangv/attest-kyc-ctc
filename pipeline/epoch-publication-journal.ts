import fs from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { EPOCH_SOURCE_ABI } from './epoch.js';
import { ROSTER_AUTH_ABI } from './roster-authorization.js';
import { writeVaultEnvelope } from './vault-atomic.js';

export class PublicationJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'PublicationJournalError'; }
}
export interface PublicationScope { chainId: number; source: string; publisher: string }
export interface PublicationIntent {
  calldata: string;
  sourceCutoff: { blockNumber: number; blockHash: string };
  availability?: { version: 1; seedHash: string; replicaCount: number };
  createdAt: number;
}
export interface PublicationConfirmation {
  transactionHash: string; blockNumber: number; blockHash: string;
  status: 0 | 1; confirmations: number; observedAt: number;
}
export interface PublicationEntry {
  id: string; intent: PublicationIntent;
  transaction?: { raw: string; hash: string; nonce: number };
  confirmation?: PublicationConfirmation;
  abandonment?: { at: number; reason: 'UNSIGNED_PLAN_CANCELLED' };
}
interface State { version: 1; scope: PublicationScope; entries: PublicationEntry[] }
const ABI = new ethers.Interface([...EPOCH_SOURCE_ABI, ...ROSTER_AUTH_ABI]);
const MAX_BYTES = 8 * 1024 * 1024;
const fail = (code: string): never => { throw new PublicationJournalError(code); };
const integer = (n: number, min = 0) => Number.isSafeInteger(n) && n >= min;
const hash = (s: string) => typeof s === 'string' && /^0x[0-9a-f]{64}$/.test(s);
function address(value: string): string {
  try { const result = ethers.getAddress(value).toLowerCase(); if (result === ethers.ZeroAddress) fail('PUBLICATION_SCOPE_INVALID'); return result; }
  catch { return fail('PUBLICATION_SCOPE_INVALID'); }
}
function scopeValue(value: PublicationScope): PublicationScope {
  if (!value || !integer(value.chainId, 1)) fail('PUBLICATION_SCOPE_INVALID');
  return { chainId: value.chainId, source: address(value.source), publisher: address(value.publisher) };
}
function intentValue(value: PublicationIntent): PublicationIntent {
  if (!value || typeof value.calldata !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(value.calldata)
    || value.calldata.length > 512 * 1024 + 2 || !integer(value.createdAt)
    || !value.sourceCutoff || !integer(value.sourceCutoff.blockNumber, 1) || !hash(value.sourceCutoff.blockHash)
    || (value.availability !== undefined && (value.availability.version !== 1 || !/^[0-9a-f]{64}$/.test(value.availability.seedHash)
      || !integer(value.availability.replicaCount, 2)))) fail('PUBLICATION_INTENT_INVALID');
  try {
    const call = ABI.parseTransaction({ data: value.calldata });
    if (!call || !['publishEpoch', 'publishEpochForIssuers'].includes(call.name)
      || ABI.encodeFunctionData(call.fragment, call.args).toLowerCase() !== value.calldata) fail('PUBLICATION_INTENT_INVALID');
  } catch { fail('PUBLICATION_INTENT_INVALID'); }
  return { calldata: value.calldata, sourceCutoff: { blockNumber: value.sourceCutoff.blockNumber, blockHash: value.sourceCutoff.blockHash },
    ...(value.availability ? { availability: { ...value.availability } } : {}), createdAt: value.createdAt };
}

/** Single-host, single-shared-path ownership. Holds an exclusive lease until close; no TTL or
 * force unlock. This storage primitive does not authenticate RPC receipts or authorize a send.
 * Publication CLI/transport integration is a separate requirement.
 */
export class EpochPublicationJournal {
  private state!: State;
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private fd!: number;
  private closed = false;
  private poisoned = false;
  readonly scope: PublicationScope;

  constructor(private readonly path: string, secret: string, scope: PublicationScope) {
    this.scope = Object.freeze(scopeValue(scope));
    if (!path || !secret || secret.length < 32) fail('PUBLICATION_JOURNAL_CONFIG');
    this.key = createHash('sha256').update('proofmark-epoch-key-v1\0').update(secret).digest();
    this.aad = Buffer.from(`proofmark-epoch-publication-v1\0${JSON.stringify(this.scope)}`);
    fs.mkdirSync(dirname(path), { recursive: true });
    try { this.fd = fs.openSync(`${path}.lock`, 'wx', 0o600); }
    catch { return fail('PUBLICATION_JOURNAL_BUSY'); }
    this.state = { version: 1, scope: this.scope, entries: [] };
    try {
      fs.writeFileSync(this.fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      if (fs.existsSync(path)) {
        const stat = fs.lstatSync(path);
        if (!stat.isFile() || stat.size > MAX_BYTES) fail('PUBLICATION_JOURNAL_UNAVAILABLE');
        const envelope = JSON.parse(fs.readFileSync(path, 'utf8'));
        if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string') fail('PUBLICATION_JOURNAL_UNAVAILABLE');
        const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
        cipher.setAAD(this.aad); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        this.state = JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
        this.validate(this.state);
      }
    } catch {
      // No authoritative publication mutation occurred during opening. Never delete its data.
      this.close(); fail('PUBLICATION_JOURNAL_UNAVAILABLE');
    }
  }

  private assertOpen(): void {
    if (this.closed) fail('PUBLICATION_JOURNAL_CLOSED');
    if (this.poisoned) fail('PUBLICATION_WRITE_UNCONFIRMED');
  }
  private id(intent: PublicationIntent): string {
    return ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(this.aad.toString()), ethers.toUtf8Bytes(JSON.stringify(intent))]));
  }
  private boundTransaction(raw: string, intent: PublicationIntent): NonNullable<PublicationEntry['transaction']> {
    try {
      if (typeof raw !== 'string' || raw.length > 520 * 1024) fail('PUBLICATION_TRANSACTION_MISMATCH');
      const tx = ethers.Transaction.from(raw);
      if (!tx.isSigned() || !tx.hash || !tx.from || tx.chainId !== BigInt(this.scope.chainId)
        || tx.from.toLowerCase() !== this.scope.publisher || tx.to?.toLowerCase() !== this.scope.source
        || tx.value !== 0n || tx.data !== intent.calldata || !integer(tx.nonce)) fail('PUBLICATION_TRANSACTION_MISMATCH');
      return { raw: tx.serialized, hash: tx.hash!, nonce: tx.nonce };
    } catch { return fail('PUBLICATION_TRANSACTION_MISMATCH'); }
  }
  private validate(state: State): void {
    if (!state || state.version !== 1 || JSON.stringify(state.scope) !== JSON.stringify(this.scope)
      || !Array.isArray(state.entries) || state.entries.length > 1000) fail('PUBLICATION_JOURNAL_UNAVAILABLE');
    const ids = new Set<string>();
    for (const [index, entry] of state.entries.entries()) {
      const intent = intentValue(entry.intent);
      if (entry.id !== this.id(intent) || ids.has(entry.id)) fail('PUBLICATION_JOURNAL_UNAVAILABLE');
      ids.add(entry.id);
      if (entry.abandonment) {
        if (entry.transaction || entry.confirmation || entry.abandonment.reason !== 'UNSIGNED_PLAN_CANCELLED'
          || !integer(entry.abandonment.at, intent.createdAt)) fail('PUBLICATION_ABANDONMENT_INVALID');
        continue;
      }
      if (entry.transaction && JSON.stringify(entry.transaction) !== JSON.stringify(this.boundTransaction(entry.transaction.raw, intent))) fail('PUBLICATION_TRANSACTION_MISMATCH');
      if (!entry.confirmation) {
        if (index !== state.entries.length - 1) fail('PUBLICATION_JOURNAL_UNAVAILABLE');
        continue;
      }
      const c = entry.confirmation;
      if (!entry.transaction || c.transactionHash !== entry.transaction.hash || !integer(c.blockNumber, 1) || !hash(c.blockHash)
        || ![0, 1].includes(c.status) || !integer(c.confirmations, 1) || !integer(c.observedAt, intent.createdAt)) fail('PUBLICATION_CONFIRMATION_INVALID');
    }
  }
  private save(next: State): void {
    this.assertOpen(); this.validate(next);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next)), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') });
    if (Buffer.byteLength(envelope) > MAX_BYTES) fail('PUBLICATION_JOURNAL_CAPACITY');
    try { writeVaultEnvelope(this.path, envelope); }
    catch { this.poisoned = true; fail('PUBLICATION_WRITE_UNCONFIRMED'); }
    this.state = next;
  }
  snapshot(): PublicationEntry[] { this.assertOpen(); return structuredClone(this.state.entries); }
  begin(value: PublicationIntent): PublicationEntry {
    this.assertOpen(); const intent = intentValue(value), id = this.id(intent);
    const same = this.state.entries.find(e => e.id === id);
    if (same) return structuredClone(same);
    if (this.state.entries.some(e => !e.confirmation && !e.abandonment)) fail('PUBLICATION_PENDING');
    if (this.state.entries.length >= 1000) fail('PUBLICATION_JOURNAL_CAPACITY');
    const next = structuredClone(this.state), entry = { id, intent };
    next.entries.push(entry); this.save(next); return structuredClone(entry);
  }
  prepare(id: string, raw: string): PublicationEntry {
    this.assertOpen(); const next = structuredClone(this.state), entry = next.entries.find(e => e.id === id);
    if (!entry) fail('PUBLICATION_NOT_FOUND');
    if (entry!.abandonment) fail('PUBLICATION_ABANDONED');
    const transaction = this.boundTransaction(raw, entry!.intent);
    if (entry!.transaction) {
      if (entry!.transaction.raw !== transaction.raw) fail('PUBLICATION_REPLACEMENT_FORBIDDEN');
      return structuredClone(entry!);
    }
    if (next.entries.some(e => e.transaction?.nonce === transaction.nonce)) fail('PUBLICATION_NONCE_REUSED');
    entry!.transaction = transaction; this.save(next); return structuredClone(entry!);
  }
  confirm(id: string, value: PublicationConfirmation): PublicationEntry {
    this.assertOpen(); const next = structuredClone(this.state), entry = next.entries.find(e => e.id === id);
    if (!entry) fail('PUBLICATION_NOT_FOUND');
    if (!value) fail('PUBLICATION_CONFIRMATION_INVALID');
    const confirmation: PublicationConfirmation = { transactionHash: value.transactionHash, blockNumber: value.blockNumber,
      blockHash: value.blockHash, status: value.status, confirmations: value.confirmations, observedAt: value.observedAt };
    if (entry!.confirmation) {
      if (JSON.stringify(entry!.confirmation) !== JSON.stringify(confirmation)) fail('PUBLICATION_CONFIRMATION_CONFLICT');
      return structuredClone(entry!);
    }
    entry!.confirmation = confirmation; this.save(next); return structuredClone(entry!);
  }
  abandonUnsigned(id: string, at: number): PublicationEntry {
    this.assertOpen(); const next = structuredClone(this.state), entry = next.entries.find(e => e.id === id);
    if (!entry) fail('PUBLICATION_NOT_FOUND');
    if (entry!.transaction || entry!.confirmation) fail('PUBLICATION_SIGNED_CANNOT_ABANDON');
    if (entry!.abandonment) return structuredClone(entry!);
    entry!.abandonment = { at, reason: 'UNSIGNED_PLAN_CANCELLED' }; this.save(next); return structuredClone(entry!);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); }
    catch { this.poisoned = true; fail('PUBLICATION_WRITE_UNCONFIRMED'); }
    if (!this.poisoned) {
      try { fs.unlinkSync(`${this.path}.lock`); }
      catch { this.poisoned = true; fail('PUBLICATION_WRITE_UNCONFIRMED'); }
    }
  }
}
