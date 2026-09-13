import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ScreeningSubject, Decision } from './aml.js';
import { normalizeRevocationObservation, RevocationObservationError, type RevocationObservation } from './revocation-observation.js';
import type { VaultMonitorSnapshot } from './vault-monitor.js';
import { VaultWriteError, writeVaultEnvelope, writeVaultEnvelopeExclusive } from './vault-atomic.js';
export { VaultWriteError } from './vault-atomic.js';

export type VaultState = 'pending' | 'active' | 'review' | 'blocked' | 'rejected';

export class RescreenConflictError extends Error {
  constructor() { super('RESCREEN_RECORD_CHANGED'); this.name = 'RescreenConflictError'; }
}
export class ReviewConflictError extends Error {
  constructor() { super('REVIEW_RECORD_CHANGED'); this.name = 'ReviewConflictError'; }
}
export class VaultBusyError extends Error {
  constructor() { super('VAULT_WRITER_BUSY'); this.name = 'VaultBusyError'; }
}
export class VaultBackupError extends Error {
  constructor(message = 'VAULT_BACKUP_UNCONFIRMED') { super(message); this.name = 'VaultBackupError'; }
}
export class VaultRestoreError extends Error {
  constructor(message: string) { super(message); this.name = 'VaultRestoreError'; }
}

export interface EvidenceVaultOptions {
  /** Waits only for a normally completing local writer. A lock is never removed or declared stale. */
  lockWaitMs?: number;
}

export interface ReviewEvent {
  at: number;
  operator: string;
  outcome: 'cleared' | 'blocked';
  reason: string;
  /** Keyed revision of the case actually reviewed; absent on legacy events. */
  basedOn?: string;
}

export interface RescreenEvent {
  at: number;
  decision: Decision;
  reason?: string;
  listVersions: Record<string, number>;
}

/** Historical successful source-receipt observation, not current canonicality or hub enforcement. */
export interface SourceIssuanceObservation {
  transactionHash: string;
  chainId: number;
  source: string;
  observedAt: number;
  /** Historical propagation acknowledgement only; never an eligibility verdict. */
  hubMaterialized?: true;
}

export interface VaultRecord {
  /** Opaque flow/request digest, never a name or document number. */
  id: string;
  walletAddress: string;
  consentVersion: string;
  /** Absent only on records created before the v1 processing-policy gate. */
  processingPolicy?: import('./privacy-processing-policy.js').ProcessingPolicyEvidenceV1;
  /** Absent only on records created before the v1 executable retention-policy gate. */
  retentionPolicy?: import('./retention-policy.js').RetentionPolicyEvidenceV1;
  screeningSubject: ScreeningSubject;
  evidenceHash: string;
  evidence: unknown;
  attrs?: string;
  claimsRoot?: string;
  claims?: unknown;
  state: VaultState;
  createdAt: number;
  retentionUntil: number;
  lastScreenedAt?: number;
  rescreens: RescreenEvent[];
  reviews: ReviewEvent[];
  sourceIssuance?: SourceIssuanceObservation;
}

export interface DeletionRequest {
  id: string;
  fingerprint: string;
  requestedAt: number;
  operator: string;
  policyRef: string;
  serviceRef: string;
  /** This operation never changes a credential on chain. */
  disposition: 'unchanged' | 'source-revoked' | 'not-issued';
  automatic: boolean;
  approval?: { operator: string; at: number };
}
type RetentionControls = {
  minimumUntil?: number;
  extensions: { until: number; operator: string; reference: string; at: number }[];
  holds: { id: string; operator: string; reference: string; at: number;
    release?: { operator: string; reference: string; at: number } }[];
  requests: DeletionRequest[];
};
type VaultData = {
  version: 2;
  /** Monotonic local mutation number. Restore safety still needs an independently retained floor. */
  revision?: number;
  records: Record<string, VaultRecord>;
  erasures: { recordId: string; at: number; reason: string; requestId?: string }[];
  revocations?: Record<string, RevocationJob>;
  retention: Record<string, RetentionControls>;
  maintenance?: { type: 'key-rotation'; at: number; operator: string; previousKeyId: string; nextKeyId: string }[];
};

const timestamp = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid retention timestamp');
};
const reference = (value: string): void => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) {
    throw new Error('use an opaque operator/policy/case reference, not free-text personal data');
  }
};

const sameListVersions = (left: Record<string, number>, right: Record<string, number>): boolean => {
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && left[key] === right[key]);
};

export interface RevocationJob {
  id: string;
  recordId: string;
  walletAddress: string;
  createdAt: number;
  state: 'pending' | 'prepared' | 'confirmed';
  /** Present for new jobs with a retained successful issuance observation. */
  sourceTarget?: { chainId: number; source: string };
  /** Signed transaction is encrypted with the outbox, persisted BEFORE broadcast. */
  transaction?: { hash: string; raw: string; chainId: number; source: string };
  confirmedAt?: number;
  lastError?: string;
  /** Append-only historical observations. None is a current eligibility or finality guarantee. */
  observations?: { recordedAt: number; observation: RevocationObservation }[];
}

type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };

export interface VaultCommitmentObservation {
  recordId: string;
  walletAddress: string;
  evidenceHash: string;
  claimsRoot?: string;
  sourceTransactionHash?: string;
}

export interface VaultBackupManifest {
  version: 1;
  backupId: string;
  createdAt: number;
  revision: number;
  stateCommitment: string;
  ciphertextHash: string;
  keyId: string;
  /** Earliest policy-bound record deadline in this whole-vault copy; null for legacy-only content. */
  deleteBy?: number | null;
}

type VaultBackupFile = VaultBackupManifest & { vaultEnvelope: string; authentication: string };

export interface VaultRestoreRequirements {
  expectedBackupId: string;
  expectedStateCommitment: string;
  minimumRevision: number;
  commitments: VaultCommitmentObservation[];
  /** Independently retained opaque erasure tombstones. Required even when currently empty. */
  erasedRecordIds: string[];
}

const deriveVaultKey = (secret: string): Buffer => {
  if (secret.length < 32) throw new Error('EVIDENCE_VAULT_KEY must be at least 32 characters');
  return createHash('sha256').update(`${secret}|proofmark-evidence-vault-v1`).digest();
};
const keyIdentifier = (key: Buffer): string => createHmac('sha256', key).update('proofmark-vault-key-id-v1').digest('hex');
const stateCommitment = (data: VaultData): string => createHash('sha256')
  .update('proofmark-vault-state-v1\0').update(JSON.stringify(data)).digest('hex');
const backupUnsigned = (file: Omit<VaultBackupFile, 'authentication'>): string => JSON.stringify(file);
const sameHex = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

function decryptVaultData(raw: string, key: Buffer): VaultData {
  const envelope = JSON.parse(raw) as Envelope;
  if (envelope.version !== 1) throw new Error(`unsupported evidence vault version ${envelope.version}`);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    if (parsed.version !== 1 && parsed.version !== 2) throw new Error('bad plaintext version');
    if (parsed.version === 1) return { ...parsed, version: 2, retention: {}, revision: 0 } as VaultData;
    if (!parsed.retention || typeof parsed.retention !== 'object' || Array.isArray(parsed.retention)
      || (parsed.revision !== undefined && (!Number.isSafeInteger(parsed.revision) || parsed.revision < 0))
      || (parsed.maintenance !== undefined && !Array.isArray(parsed.maintenance))) throw new Error('bad vault controls');
    return parsed.revision === undefined ? { ...parsed, revision: 0 } as VaultData : parsed as VaultData;
  } catch {
    throw new Error('evidence vault authentication failed (wrong key or corrupt file)');
  }
}

/**
 * Encrypted, file-backed pilot vault. Each write replaces one AES-256-GCM envelope atomically.
 * Deploy it only on persistent encrypted storage; Vercel functions do not provide that guarantee.
 */
export class EvidenceVault {
  private data: VaultData;
  private key: Buffer;
  private writeUnconfirmed = false;
  private readonly lockWaitMs: number;

  constructor(private readonly path: string, secret: string, options: EvidenceVaultOptions = {}) {
    const lockWaitMs = options.lockWaitMs ?? 5_000;
    if (!Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0 || lockWaitMs > 60_000) throw new Error('invalid vault lock wait');
    this.lockWaitMs = lockWaitMs;
    this.key = deriveVaultKey(secret);
    this.data = this.load();
  }

  recoveryState(): { revision: number; stateCommitment: string; keyId: string } {
    this.data = this.load();
    return { revision: this.data.revision ?? 0, stateCommitment: stateCommitment(this.data), keyId: keyIdentifier(this.key) };
  }

  /** Captures the exact encrypted envelope while excluding concurrent writers. The backup path must be new. */
  createBackup(backupPath: string, at = Date.now()): VaultBackupManifest {
    timestamp(at);
    if (resolve(backupPath) === resolve(this.path)) throw new VaultBackupError('VAULT_BACKUP_PATH_INVALID');
    if (!existsSync(this.path)) throw new VaultBackupError('VAULT_BACKUP_SOURCE_MISSING');
    mkdirSync(dirname(backupPath), { recursive: true });
    const lockPath = `${this.path}.lock`, lock = this.acquireLock(lockPath);
    let lockWritten = false;
    try {
      try { writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), operation: 'backup' })); }
      catch { this.writeUnconfirmed = true; throw new VaultWriteError(); }
      lockWritten = true;
      const raw = readFileSync(this.path, 'utf8');
      this.data = this.decrypt(raw);
      const unsigned: Omit<VaultBackupFile, 'authentication'> = {
        version: 1, backupId: randomBytes(16).toString('hex'), createdAt: at, revision: this.data.revision ?? 0,
        stateCommitment: stateCommitment(this.data), ciphertextHash: createHash('sha256').update(raw).digest('hex'),
        keyId: keyIdentifier(this.key),
        deleteBy: Object.values(this.data.records).some(record => !!record.retentionPolicy)
          ? Math.min(...Object.values(this.data.records).filter(record => !!record.retentionPolicy).map(record => this.retentionDeadline(record)))
          : null,
        vaultEnvelope: raw,
      };
      const file: VaultBackupFile = { ...unsigned,
        authentication: createHmac('sha256', this.key).update('proofmark-vault-backup-v1\0').update(backupUnsigned(unsigned)).digest('hex') };
      try { writeVaultEnvelopeExclusive(backupPath, JSON.stringify(file)); }
      catch { throw new VaultBackupError(); }
      const { vaultEnvelope: _vaultEnvelope, authentication: _authentication, ...manifest } = file;
      return manifest;
    } finally {
      try { closeSync(lock); }
      catch { this.writeUnconfirmed = true; throw new VaultWriteError(); }
      if (lockWritten) {
        try { unlinkSync(lockPath); }
        catch { this.writeUnconfirmed = true; throw new VaultWriteError(); }
      }
    }
  }

  /** Re-encrypts the current authoritative file under the same writer fence. Old backups are unaffected. */
  rotateKey(newSecret: string, operator: string, at = Date.now()): { revision: number; stateCommitment: string; previousKeyId: string; nextKeyId: string } {
    timestamp(at); reference(operator);
    const nextKey = deriveVaultKey(newSecret), previousKeyId = keyIdentifier(this.key), nextKeyId = keyIdentifier(nextKey);
    if (previousKeyId === nextKeyId) throw new Error('vault rotation requires a different key');
    this.mutate(() => {
      this.data.maintenance ??= [];
      this.data.maintenance.push({ type: 'key-rotation', at, operator, previousKeyId, nextKeyId });
    }, nextKey);
    this.key = nextKey;
    return { revision: this.data.revision ?? 0, stateCommitment: stateCommitment(this.data), previousKeyId, nextKeyId };
  }

  /** Restores only into an absent destination and requires an independently supplied backup/state/revision floor. */
  static restoreBackup(backupPath: string, destinationPath: string, secret: string, requirements: VaultRestoreRequirements,
    options: EvidenceVaultOptions = {}): { manifest: VaultBackupManifest; matchedCommitments: number } {
    if (resolve(backupPath) === resolve(destinationPath) || existsSync(destinationPath)) throw new VaultRestoreError('VAULT_RESTORE_DESTINATION_NOT_EMPTY');
    const key = deriveVaultKey(secret);
    let parsedFile: unknown;
    try { parsedFile = JSON.parse(readFileSync(backupPath, 'utf8')); }
    catch { throw new VaultRestoreError('VAULT_BACKUP_UNREADABLE'); }
    if (!parsedFile || typeof parsedFile !== 'object' || Array.isArray(parsedFile)) throw new VaultRestoreError('VAULT_BACKUP_AUTHENTICATION_FAILED');
    const file = parsedFile as VaultBackupFile;
    const { authentication, ...unsigned } = file;
    const expectedAuth = createHmac('sha256', key).update('proofmark-vault-backup-v1\0').update(backupUnsigned(unsigned)).digest();
    const receivedAuth = typeof authentication === 'string' && /^[0-9a-f]{64}$/.test(authentication) ? Buffer.from(authentication, 'hex') : Buffer.alloc(0);
    if (file.version !== 1 || !/^[0-9a-f]{32}$/.test(file.backupId) || !Number.isSafeInteger(file.createdAt) || file.createdAt < 0
      || !Number.isSafeInteger(file.revision) || file.revision < 0 || !/^[0-9a-f]{64}$/.test(file.stateCommitment)
      || !/^[0-9a-f]{64}$/.test(file.ciphertextHash) || !/^[0-9a-f]{64}$/.test(file.keyId)
      || (file.deleteBy !== undefined && file.deleteBy !== null
        && (!Number.isSafeInteger(file.deleteBy) || file.deleteBy < file.createdAt))
      || typeof file.vaultEnvelope !== 'string' || receivedAuth.length !== expectedAuth.length || !timingSafeEqual(receivedAuth, expectedAuth)
      || file.keyId !== keyIdentifier(key) || createHash('sha256').update(file.vaultEnvelope).digest('hex') !== file.ciphertextHash) {
      throw new VaultRestoreError('VAULT_BACKUP_AUTHENTICATION_FAILED');
    }
    let data: VaultData;
    try { data = decryptVaultData(file.vaultEnvelope, key); }
    catch { throw new VaultRestoreError('VAULT_BACKUP_AUTHENTICATION_FAILED'); }
    if (!requirements || requirements.expectedBackupId !== file.backupId || requirements.expectedStateCommitment !== file.stateCommitment
      || !Number.isSafeInteger(requirements.minimumRevision) || requirements.minimumRevision < 0
      || file.revision < requirements.minimumRevision || stateCommitment(data) !== file.stateCommitment
      || (data.revision ?? 0) !== file.revision || !Array.isArray(requirements.commitments)
      || !Array.isArray(requirements.erasedRecordIds)
      || requirements.erasedRecordIds.some(id => typeof id !== 'string' || !id || id.length > 256)
      || new Set(requirements.erasedRecordIds).size !== requirements.erasedRecordIds.length) {
      throw new VaultRestoreError('VAULT_RESTORE_REQUIREMENTS_MISMATCH');
    }
    if (file.deleteBy !== undefined && file.deleteBy !== null && Date.now() >= file.deleteBy) throw new VaultRestoreError('VAULT_BACKUP_EXPIRED');
    if (requirements.erasedRecordIds.some(id => !!data.records[id])) throw new VaultRestoreError('VAULT_ERASURE_FLOOR_VIOLATION');
    for (const observation of requirements.commitments) {
      if (!observation || typeof observation.recordId !== 'string' || !observation.recordId
        || typeof observation.walletAddress !== 'string' || typeof observation.evidenceHash !== 'string'
        || (observation.claimsRoot !== undefined && typeof observation.claimsRoot !== 'string')
        || (observation.sourceTransactionHash !== undefined && typeof observation.sourceTransactionHash !== 'string')) {
        throw new VaultRestoreError('VAULT_ONCHAIN_COMMITMENT_MISMATCH');
      }
      const record = data.records[observation.recordId];
      if (!record || !sameHex(record.walletAddress, observation.walletAddress) || !sameHex(record.evidenceHash, observation.evidenceHash)
        || (observation.claimsRoot !== undefined && (!record.claimsRoot || !sameHex(record.claimsRoot, observation.claimsRoot)))
        || (observation.sourceTransactionHash !== undefined && (!record.sourceIssuance
          || !sameHex(record.sourceIssuance.transactionHash, observation.sourceTransactionHash)))) {
        throw new VaultRestoreError('VAULT_ONCHAIN_COMMITMENT_MISMATCH');
      }
    }
    mkdirSync(dirname(destinationPath), { recursive: true });
    const destination = new EvidenceVault(destinationPath, secret, options), lockPath = `${destinationPath}.lock`;
    const lock = destination.acquireLock(lockPath); let retainLock = false;
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now(), operation: 'restore', backupId: file.backupId }));
      if (existsSync(destinationPath)) throw new VaultRestoreError('VAULT_RESTORE_DESTINATION_NOT_EMPTY');
      try { writeVaultEnvelopeExclusive(destinationPath, file.vaultEnvelope); }
      catch { retainLock = true; throw new VaultRestoreError('VAULT_RESTORE_WRITE_UNCONFIRMED'); }
      const restored = decryptVaultData(readFileSync(destinationPath, 'utf8'), key);
      if (stateCommitment(restored) !== file.stateCommitment) { retainLock = true; throw new VaultRestoreError('VAULT_RESTORE_VERIFY_FAILED'); }
    } finally {
      try { closeSync(lock); } catch { retainLock = true; }
      if (!retainLock) {
        try { unlinkSync(lockPath); } catch { retainLock = true; }
      }
      if (retainLock) throw new VaultRestoreError('VAULT_RESTORE_WRITE_UNCONFIRMED');
    }
    const { vaultEnvelope: _vaultEnvelope, authentication: _authentication, ...manifest } = file;
    return { manifest, matchedCommitments: requirements.commitments.length };
  }

  put(record: VaultRecord): VaultRecord {
    return this.mutate(() => {
      if (!record.id || !record.walletAddress || !record.screeningSubject?.fullName) throw new Error('incomplete vault record');
      if (this.data.erasures.some(event => event.recordId === record.id)) throw new Error('erased vault record cannot be restored by put');
      timestamp(record.createdAt); timestamp(record.retentionUntil);
      if (record.retentionUntil < record.createdAt) throw new Error('retention precedes creation');
      if (record.retentionPolicy && (record.retentionPolicy.vaultDeleteAt !== record.retentionUntil
        || (record.processingPolicy && record.retentionPolicy.customerId !== record.processingPolicy.customerId))) {
        throw new Error('vault record does not match its retention policy snapshot');
      }
      const existing = this.data.records[record.id];
      if (existing) {
        if (existing.evidenceHash !== record.evidenceHash) throw new Error(`vault record ${record.id} conflicts with existing evidence`);
        return structuredClone(existing);
      }
      this.data.records[record.id] = structuredClone(record);
      return structuredClone(record);
    });
  }

  get(id: string): VaultRecord | undefined {
    this.data = this.load();
    const record = this.data.records[id];
    return record ? structuredClone(record) : undefined;
  }

  recordMaterialization(id: string, evidenceHash: string): void {
    this.mutate(() => {
      const record = this.mustGet(id);
      if (record.evidenceHash !== evidenceHash) throw new Error('materialization evidence does not match retained record');
      if (record.sourceIssuance) record.sourceIssuance.hubMaterialized = true;
      // A later compliance decision must never be erased by an asynchronous issuance callback.
      if (record.state === 'pending') record.state = 'active';
    });
  }

  recordSourceConfirmation(id: string, evidenceHash: string, observation: SourceIssuanceObservation): void {
    this.mutate(() => {
      const record = this.mustGet(id);
      if (record.evidenceHash !== evidenceHash) throw new Error('source confirmation evidence does not match retained record');
      timestamp(observation.observedAt);
      if (!Number.isSafeInteger(observation.chainId) || observation.chainId <= 0
        || !/^0x[0-9a-fA-F]{64}$/.test(observation.transactionHash)
        || !/^0x[0-9a-fA-F]{40}$/.test(observation.source)
        || observation.observedAt < record.createdAt) throw new Error('invalid source confirmation observation');
      const next: SourceIssuanceObservation = { observedAt: observation.observedAt, chainId: observation.chainId,
        transactionHash: observation.transactionHash.toLowerCase(), source: observation.source.toLowerCase() };
      const previous = record.sourceIssuance;
      if (previous) {
        if (previous.transactionHash !== next.transactionHash || previous.chainId !== next.chainId || previous.source !== next.source) {
          throw new Error('source confirmation conflicts with retained issuance');
        }
        return; // Preserve the first observation and screening/decision history on replay.
      }
      record.sourceIssuance = next;
      // Do not clear a concurrent review/BLOCK or equate source success with hub materialization.
    });
  }

  listForRescreen(now: number, intervalMs: number, currentListVersions?: Record<string, number>): VaultRecord[] {
    this.data = this.load();
    return Object.values(this.data.records)
      .filter((record) => this.retentionDeadline(record) > now)
      .filter((record) => record.state === 'active' || record.state === 'review' || (record.state === 'pending' && !!record.sourceIssuance))
      .filter((record) => {
        if (!record.lastScreenedAt || now - record.lastScreenedAt >= intervalMs) return true;
        if (currentListVersions === undefined) return false;
        const previous = record.rescreens.at(-1)?.listVersions;
        return previous === undefined || !sameListVersions(previous, currentListVersions);
      })
      .map((record) => structuredClone(record));
  }

  /** expected must be the retained snapshot taken BEFORE awaiting the screening engine.
   * Compare under the writer lock: reloading alone does not fence a stale decision.
   */
  recordRescreen(id: string, event: RescreenEvent, expected: VaultRecord): VaultRecord {
    return this.mutate(() => {
      const record = this.data.records[id];
      if (!record || !expected || expected.id !== id || !isDeepStrictEqual(record, expected)) throw new RescreenConflictError();
      if (record.state === 'blocked' || record.state === 'rejected') throw new Error('terminal compliance state requires explicit review; rescreen cannot clear it');
      timestamp(event.at);
      const latestDecisionAt = record.reviews.reduce((latest, review) => Math.max(latest, review.at), Math.max(record.createdAt, record.lastScreenedAt ?? 0));
      if (event.at < latestDecisionAt) {
        throw new Error('rescreen timestamp precedes retained decision');
      }
      if (!['ALLOW', 'REVIEW', 'BLOCK'].includes(event.decision)) throw new Error('invalid rescreen decision');
      record.lastScreenedAt = event.at;
      record.rescreens.push(structuredClone(event));
      record.state = event.decision === 'BLOCK' ? 'blocked' : event.decision === 'REVIEW' ? 'review'
        : record.state === 'pending' || (record.sourceIssuance && !record.sourceIssuance.hubMaterialized) ? 'pending' : 'active';
      if (event.decision === 'BLOCK') this.queueRevocation(record, event.at);
      return structuredClone(record);
    });
  }

  /** Read before deciding, not immediately before committing an older decision. */
  reviewSnapshot(id: string): { revision: string; record: VaultRecord } {
    this.data = this.decrypt(readFileSync(this.path, 'utf8'));
    const record = this.data.records[id]; if (!record) throw new ReviewConflictError();
    return { revision: this.reviewRevision(record), record: structuredClone(record) };
  }

  private reviewRevision(record: VaultRecord): string {
    const jobs = Object.values(this.data.revocations ?? {}).filter(job => job.recordId === record.id).sort((a, b) => a.id.localeCompare(b.id));
    return createHmac('sha256', this.key).update('proofmark-review-revision-v1\0')
      .update(JSON.stringify([record, jobs, this.data.retention[record.id] ?? null])).digest('hex');
  }

  decideReview(id: string, event: ReviewEvent, expectedRevision: string): VaultRecord {
    return this.mutate(() => {
      const record = this.data.records[id];
      if (!record || typeof expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(expectedRevision)
        || this.reviewRevision(record) !== expectedRevision) throw new ReviewConflictError();
      timestamp(event.at); reference(event.operator); reference(event.reason);
      if (event.outcome !== 'cleared' && event.outcome !== 'blocked') throw new Error('invalid review outcome');
      const latest = record.reviews.reduce((at, review) => Math.max(at, review.at), Math.max(record.createdAt, record.lastScreenedAt ?? 0));
      if (event.at < latest) throw new Error('review timestamp precedes retained decision');
      if (event.outcome === 'cleared' && Object.values(this.data.revocations ?? {}).some(job => job.recordId === id && job.state !== 'confirmed')) {
        throw new Error('pending revocation must be reconciled before clearance; clearance does not reissue on chain');
      }
      record.reviews.push({ at: event.at, operator: event.operator, outcome: event.outcome, reason: event.reason, basedOn: expectedRevision });
      record.state = event.outcome === 'cleared'
        ? record.state === 'pending' || (record.sourceIssuance && !record.sourceIssuance.hubMaterialized) ? 'pending' : 'active'
        : 'blocked';
      if (event.outcome === 'blocked') this.queueRevocation(record, event.at);
      return structuredClone(record);
    });
  }

  /** These operator labels are an audit trail, NOT authentication or an IAM boundary. */
  extendRetention(id: string, until: number, operator: string, ref: string, at = Date.now()): void {
    this.mutate(() => {
      timestamp(at); timestamp(until); reference(operator); reference(ref);
      const record = this.mustGet(id);
      const controls = this.controls(id);
      if (until <= Math.max(record.retentionUntil, controls.minimumUntil ?? 0)) throw new Error('retention can only be extended');
      controls.minimumUntil = until;
      controls.extensions.push({ until, operator, reference: ref, at });
    });
  }

  placeHold(id: string, holdId: string, operator: string, ref: string, at = Date.now()): void {
    this.mutate(() => {
      this.mustGet(id); timestamp(at); reference(holdId); reference(operator); reference(ref);
      const controls = this.controls(id);
      if (controls.holds.some(hold => hold.id === holdId)) throw new Error('hold ID already used');
      controls.holds.push({ id: holdId, operator, reference: ref, at });
    });
  }

  releaseHold(id: string, holdId: string, operator: string, ref: string, at = Date.now()): void {
    this.mutate(() => {
      this.mustGet(id); timestamp(at); reference(operator); reference(ref);
      const hold = this.controls(id).holds.find(item => item.id === holdId);
      if (!hold || hold.release) throw new Error('unknown or already released hold');
      if (at < hold.at) throw new Error('hold release precedes placement');
      hold.release = { operator, reference: ref, at };
    });
  }

  requestDeletion(id: string, input: Pick<DeletionRequest, 'operator' | 'policyRef' | 'serviceRef' | 'disposition' | 'automatic'>,
    at = Date.now()): DeletionRequest {
    return this.mutate(() => {
      timestamp(at); reference(input.operator); reference(input.policyRef); reference(input.serviceRef);
      if (typeof input.automatic !== 'boolean' || !['unchanged', 'source-revoked', 'not-issued'].includes(input.disposition)) throw new Error('invalid deletion decision');
      const record = this.mustGet(id);
      if (record.retentionPolicy) {
        const expectedPolicyRef = record.retentionPolicy.approvalRef ?? record.retentionPolicy.policyId;
        if (input.policyRef !== expectedPolicyRef || input.disposition !== record.retentionPolicy.credentialDisposition) {
          throw new Error('deletion decision does not match the retained policy snapshot');
        }
      }
      const blockers = this.safetyBlockers(record, at).filter(code => code !== 'RETENTION_NOT_EXPIRED');
      if (blockers.length) throw new Error(`deletion blocked: ${blockers.join(',')}`);
      const confirmed = Object.values(this.data.revocations ?? {}).some(job => job.recordId === id && job.state === 'confirmed');
      if ((input.disposition === 'source-revoked' && !confirmed)
        || (input.disposition === 'not-issued' && record.state !== 'rejected')
        || (record.state === 'blocked' && input.disposition !== 'source-revoked')) throw new Error('service disposition is not supported by local evidence');
      const request: DeletionRequest = { id: randomBytes(16).toString('hex'), fingerprint: this.deletionFingerprint(record),
        requestedAt: at, operator: input.operator, policyRef: input.policyRef, serviceRef: input.serviceRef,
        disposition: input.disposition, automatic: input.automatic };
      this.controls(id).requests.push(request);
      return structuredClone(request);
    });
  }

  approveDeletion(id: string, requestId: string, operator: string, at = Date.now()): void {
    this.mutate(() => {
      timestamp(at); reference(operator);
      const record = this.mustGet(id);
      const request = this.controls(id).requests.at(-1);
      if (!request || request.id !== requestId) throw new Error('deletion request is not current');
      if (request.operator === operator) throw new Error('deletion requires a different approver label');
      if (request.approval) throw new Error('deletion request already approved');
      if (at < request.requestedAt) throw new Error('approval precedes request');
      if (request.fingerprint !== this.deletionFingerprint(record)) throw new Error('deletion request is stale');
      const blockers = this.safetyBlockers(record, at).filter(code => code !== 'RETENTION_NOT_EXPIRED');
      if (blockers.length) throw new Error(`deletion blocked: ${blockers.join(',')}`);
      request.approval = { operator, at };
    });
  }

  /** Read-only, no directories, locks, or ciphertext rewrites. Does not return KYC evidence. */
  deletionPreview(now = Date.now()): { recordId: string; retentionUntil: number; requestId?: string; automatic: boolean; blockers: string[] }[] {
    timestamp(now); this.data = this.load();
    return Object.values(this.data.records).map(record => {
      const request = this.data.retention[record.id]?.requests.at(-1);
      return { recordId: record.id, retentionUntil: this.retentionDeadline(record), requestId: request?.id,
        automatic: request?.automatic === true, blockers: this.deletionBlockers(record, now) };
    });
  }

  erase(id: string, requestId: string, at = Date.now()): boolean {
    return this.mutate(() => {
      timestamp(at);
      const record = this.data.records[id];
      if (!record) return false;
      const request = this.controls(id).requests.at(-1);
      if (!request || request.id !== requestId) throw new Error('deletion request is not current');
      const blockers = this.deletionBlockers(record, at);
      if (blockers.length) throw new Error(`deletion blocked: ${blockers.join(',')}`);
      this.eraseApproved(record, request, at);
      return true;
    });
  }

  purgeExpired(now = Date.now()): number {
    return this.mutate(() => {
      timestamp(now);
      let count = 0;
      for (const record of Object.values(this.data.records)) {
        const request = this.data.retention[record.id]?.requests.at(-1);
        if (!request?.automatic || this.deletionBlockers(record, now).length) continue;
        this.eraseApproved(record, request, now); count++;
      }
      return count;
    });
  }

  private controls(id: string): RetentionControls {
    return this.data.retention[id] ??= { extensions: [], holds: [], requests: [] };
  }

  private retentionDeadline(record: VaultRecord): number {
    return Math.max(record.retentionUntil, this.data.retention[record.id]?.minimumUntil ?? 0);
  }

  private safetyBlockers(record: VaultRecord, now: number): string[] {
    const result: string[] = [];
    const deadline = this.retentionDeadline(record);
    if (!Number.isSafeInteger(record.retentionUntil) || !Number.isSafeInteger(deadline) || !Number.isSafeInteger(record.createdAt)
      || record.createdAt < 0 || record.retentionUntil < record.createdAt || deadline < record.createdAt) result.push('INVALID_RETENTION');
    else if (now < deadline) result.push('RETENTION_NOT_EXPIRED');
    if (now < record.createdAt) result.push('RECORD_TIME_INVALID');
    if (this.data.retention[record.id]?.holds.some(hold => !hold.release)) result.push('LEGAL_HOLD');
    if (record.state === 'pending') result.push('ISSUANCE_PENDING');
    if (record.state === 'review') result.push('REVIEW_PENDING');
    if (!['pending', 'review', 'active', 'blocked', 'rejected'].includes(record.state)) result.push('UNKNOWN_STATE');
    const jobs = Object.values(this.data.revocations ?? {}).filter(job => job.recordId === record.id);
    if (jobs.some(job => job.state !== 'confirmed')) result.push('REVOCATION_PENDING');
    if (record.state === 'blocked' && !jobs.some(job => job.state === 'confirmed')) result.push('REVOCATION_NOT_RECONCILED');
    return result;
  }

  private deletionFingerprint(record: VaultRecord): string {
    const controls = this.data.retention[record.id];
    const jobs = Object.values(this.data.revocations ?? {}).filter(job => job.recordId === record.id).sort((a, b) => a.id.localeCompare(b.id));
    return createHash('sha256').update('proofmark-vault-deletion-v1\0').update(JSON.stringify({ record,
      minimumUntil: controls?.minimumUntil, extensions: controls?.extensions ?? [], holds: controls?.holds ?? [], jobs })).digest('hex');
  }

  private deletionBlockers(record: VaultRecord, now: number): string[] {
    const result = this.safetyBlockers(record, now);
    const request = this.data.retention[record.id]?.requests.at(-1);
    if (!request?.approval) result.push('DELETION_NOT_APPROVED');
    if (request && request.fingerprint !== this.deletionFingerprint(record)) result.push('DELETION_REQUEST_STALE');
    if (request?.approval && (now < request.approval.at || request.approval.at < request.requestedAt)) result.push('APPROVAL_TIME_INVALID');
    return result;
  }

  private eraseApproved(record: VaultRecord, request: DeletionRequest, at: number): void {
    delete this.data.records[record.id];
    this.data.erasures.push({ recordId: record.id, at, reason: request.policyRef, requestId: request.id });
    // Retain the deletion controls/tombstone and confirmed reconciliation outbox. NOT global erasure.
  }

  counts(): Record<string, number> {
    this.data = this.load();
    const out: Record<string, number> = { erased: this.data.erasures.length };
    for (const record of Object.values(this.data.records)) out[record.state] = (out[record.state] ?? 0) + 1;
    return out;
  }

  monitoringSnapshot(): VaultMonitorSnapshot {
    if (!existsSync(this.path)) throw new Error('MONITOR_VAULT_NOT_FOUND');
    // Unlike the create-capable loader, disappearance during this read must not become an empty report.
    this.data = this.decrypt(readFileSync(this.path, 'utf8'));
    return {
      records: Object.values(this.data.records).map(record => ({ id: record.id, state: record.state, createdAt: record.createdAt,
        retentionUntil: this.retentionDeadline(record), lastScreenedAt: record.lastScreenedAt, sourceObserved: !!record.sourceIssuance })),
      revocations: Object.values(this.data.revocations ?? {}).map(job => {
        const last = job.observations?.at(-1)?.observation;
        return { id: job.id, recordId: job.recordId, state: job.state, createdAt: job.createdAt, confirmedAt: job.confirmedAt,
          hasError: !!job.lastError, latestObservation: last ? { state: last.state, observedAt: last.observedAt } : undefined };
      }),
    };
  }

  listPendingRevocations(): RevocationJob[] {
    this.data = this.load();
    return Object.values(this.data.revocations ?? {}).filter(job => job.state !== 'confirmed').map(job => structuredClone(job));
  }

  getRevocation(id: string): RevocationJob | undefined {
    this.data = this.load();
    const job = this.data.revocations?.[id];
    return job ? structuredClone(job) : undefined;
  }

  recordRevocationObservation(id: string, expected: RevocationJob, input: RevocationObservation, recordedAt = Date.now()): void {
    this.mutate(() => {
      const job = this.data.revocations?.[id];
      if (!job || !expected || expected.id !== id || !isDeepStrictEqual(job, expected)) throw new RevocationObservationError('REVOCATION_JOB_CHANGED');
      const observation = normalizeRevocationObservation(input);
      timestamp(recordedAt);
      if (!job.transaction || job.transaction.chainId !== 11155111
        || job.transaction.hash.toLowerCase() !== observation.source.transactionHash
        || job.transaction.source.toLowerCase() !== observation.config.source
        || (job.sourceTarget && (job.sourceTarget.chainId !== 11155111 || job.sourceTarget.source.toLowerCase() !== observation.config.source))) {
        throw new RevocationObservationError('REVOCATION_OBSERVATION_TARGET_MISMATCH');
      }
      if (recordedAt < observation.observedAt * 1000 || recordedAt - observation.observedAt * 1000 > 300000
        || recordedAt < job.createdAt || observation.observedAt < Math.floor(job.createdAt / 1000)) throw new RevocationObservationError('STALE_REVOCATION_OBSERVATION');
      const previous = job.observations?.at(-1);
      if (previous && (observation.observedAt < previous.observation.observedAt || recordedAt < previous.recordedAt)) throw new RevocationObservationError('BACKDATED_REVOCATION_OBSERVATION');
      if (previous && isDeepStrictEqual(previous.observation, observation)) return;
      job.observations ??= [];
      job.observations.push({ recordedAt, observation });
      // Do not change source delivery status, compliance state, approvals or deletion authority.
    });
  }

  listLegacyBlocked(): { recordId: string; walletAddress: string }[] {
    this.data = this.load();
    return Object.values(this.data.records)
      .filter(record => record.state === 'blocked' && !Object.values(this.data.revocations ?? {}).some(job => job.recordId === record.id))
      .map(record => ({ recordId: record.id, walletAddress: record.walletAddress }));
  }

  /** Recover blocked records written by the old CLI, without requiring another screening pass. */
  recoverBlockedRevocations(now: number): void {
    this.mutate(() => {
      for (const record of Object.values(this.data.records)) {
        if (record.state === 'blocked' && !Object.values(this.data.revocations ?? {}).some(job => job.recordId === record.id)) {
          this.queueRevocation(record, now);
        }
      }
    });
  }

  prepareRevocation(id: string, transaction: NonNullable<RevocationJob['transaction']>): RevocationJob {
    return this.mutate(() => {
      const job = this.mustGetJob(id);
      if (job.state === 'confirmed') throw new Error('revocation already confirmed');
      if (job.transaction && job.transaction.hash !== transaction.hash) throw new Error('revocation already has a different signed transaction');
      job.transaction = structuredClone(transaction);
      job.state = 'prepared';
      return structuredClone(job);
    });
  }

  finishRevocation(id: string, at: number): void {
    this.mutate(() => {
      const job = this.mustGetJob(id);
      if (!job.transaction) throw new Error('revocation has no prepared transaction');
      job.state = 'confirmed';
      job.confirmedAt = at;
      delete job.lastError;
      // Keep the hash for reconciliation; raw transaction is no longer needed.
      job.transaction.raw = '';
    });
  }

  failRevocation(id: string, error: string, minedRevert = false): void {
    this.mutate(() => {
      const job = this.mustGetJob(id);
      if (job.state === 'confirmed') throw new Error('cannot fail a confirmed revocation');
      job.lastError = error.slice(0, 200);
      // Only a confirmed revert permits a new nonce/signature. Unknown broadcast outcomes retain it.
      if (minedRevert) { job.state = 'pending'; delete job.transaction; }
    });
  }

  private queueRevocation(record: VaultRecord, at: number): void {
    this.data.revocations ??= {};
    if (Object.values(this.data.revocations).some(job => job.recordId === record.id && job.state !== 'confirmed')) return;
    const id = `${record.id}:revoke:${at}`;
    if (this.data.revocations[id]) throw new Error('revocation event ID already used');
    this.data.revocations[id] = { id, recordId: record.id, walletAddress: record.walletAddress, createdAt: at, state: 'pending' };
    if (record.sourceIssuance) this.data.revocations[id].sourceTarget = {
      chainId: record.sourceIssuance.chainId, source: record.sourceIssuance.source,
    };
  }

  private mustGetJob(id: string): RevocationJob {
    const job = this.data.revocations?.[id];
    if (!job) throw new Error('unknown revocation job');
    return job;
  }

  private load(): VaultData {
    return existsSync(this.path) ? this.decrypt(readFileSync(this.path, 'utf8'))
      : { version: 2, revision: 0, records: {}, erasures: [], revocations: {}, retention: {} };
  }

  /** A lock is not proof of a dead owner. External delivery must wait for verified recovery. */
  assertWritable(): void {
    if (this.writeUnconfirmed || existsSync(`${this.path}.lock`)) throw new VaultWriteError();
  }

  /** Single-host exclusive writer. Reload under lock prevents stale instances from losing writes.
   * A crashed lock is never stolen automatically: the operator must establish that its owner is dead.
   */
  private mutate<T>(operation: () => T, writeKey = this.key): T {
    if (this.writeUnconfirmed) throw new VaultWriteError();
    mkdirSync(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    const lock = this.acquireLock(lockPath);
    let retainLock = false;
    try {
      try { writeFileSync(lock, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
      catch { throw new VaultWriteError(); }
      this.data = this.load();
      const result = operation();
      this.data.revision = (this.data.revision ?? 0) + 1;
      this.flush(writeKey);
      return result;
    } catch (error) {
      if (error instanceof VaultWriteError) { retainLock = true; this.writeUnconfirmed = true; }
      try { this.data = this.load(); } catch { /* preserve the original failure; no speculative writes */ }
      throw error;
    } finally {
      try { closeSync(lock); }
      catch { this.writeUnconfirmed = true; throw new VaultWriteError(); }
      if (!retainLock) {
        try { unlinkSync(lockPath); }
        catch { this.writeUnconfirmed = true; throw new VaultWriteError(); }
      }
    }
  }

  private acquireLock(lockPath: string): number {
    const deadline = Date.now() + this.lockWaitMs;
    const signal = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
      try { return openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new VaultBusyError();
        Atomics.wait(signal, 0, 0, Math.min(10, remaining));
      }
    }
  }

  private mustGet(id: string): VaultRecord {
    const record = this.data.records[id];
    if (!record) throw new Error(`unknown vault record ${id}`);
    return record;
  }

  private decrypt(raw: string): VaultData {
    return decryptVaultData(raw, this.key);
  }

  private flush(key = this.key): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    writeVaultEnvelope(this.path, JSON.stringify(envelope));
  }
}
