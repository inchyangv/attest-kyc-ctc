import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ScreeningSubject, Decision } from './aml.js';

export type VaultState = 'active' | 'review' | 'blocked' | 'rejected';

export interface ReviewEvent {
  at: number;
  operator: string;
  outcome: 'cleared' | 'blocked';
  reason: string;
}

export interface RescreenEvent {
  at: number;
  decision: Decision;
  reason?: string;
  listVersions: Record<string, number>;
}

export interface VaultRecord {
  /** Opaque flow/request digest, never a name or document number. */
  id: string;
  walletAddress: string;
  consentVersion: string;
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
}

type VaultData = {
  version: 1;
  records: Record<string, VaultRecord>;
  erasures: { recordId: string; at: number; reason: string }[];
};

type Envelope = { version: 1; iv: string; tag: string; ciphertext: string };

/**
 * Encrypted, file-backed pilot vault. Each write replaces one AES-256-GCM envelope atomically.
 * Deploy it only on persistent encrypted storage; Vercel functions do not provide that guarantee.
 */
export class EvidenceVault {
  private data: VaultData;
  private readonly key: Buffer;

  constructor(private readonly path: string, secret: string) {
    if (secret.length < 32) throw new Error('EVIDENCE_VAULT_KEY must be at least 32 characters');
    this.key = createHash('sha256').update(`${secret}|proofmark-evidence-vault-v1`).digest();
    mkdirSync(dirname(path), { recursive: true });
    this.data = existsSync(path) ? this.decrypt(readFileSync(path, 'utf8')) : { version: 1, records: {}, erasures: [] };
  }

  put(record: VaultRecord): VaultRecord {
    if (!record.id || !record.walletAddress || !record.screeningSubject?.fullName) throw new Error('incomplete vault record');
    const existing = this.data.records[record.id];
    if (existing) {
      if (existing.evidenceHash !== record.evidenceHash) throw new Error(`vault record ${record.id} conflicts with existing evidence`);
      return structuredClone(existing);
    }
    this.data.records[record.id] = structuredClone(record);
    this.flush();
    return structuredClone(record);
  }

  get(id: string): VaultRecord | undefined {
    const record = this.data.records[id];
    return record ? structuredClone(record) : undefined;
  }

  listForRescreen(now: number, intervalMs: number): VaultRecord[] {
    return Object.values(this.data.records)
      .filter((record) => record.retentionUntil > now)
      .filter((record) => record.state === 'active' || record.state === 'review')
      .filter((record) => !record.lastScreenedAt || now - record.lastScreenedAt >= intervalMs)
      .map((record) => structuredClone(record));
  }

  recordRescreen(id: string, event: RescreenEvent): VaultRecord {
    const record = this.mustGet(id);
    record.lastScreenedAt = event.at;
    record.rescreens.push(structuredClone(event));
    record.state = event.decision === 'BLOCK' ? 'blocked' : event.decision === 'REVIEW' ? 'review' : 'active';
    this.flush();
    return structuredClone(record);
  }

  decideReview(id: string, event: ReviewEvent): VaultRecord {
    const record = this.mustGet(id);
    record.reviews.push(structuredClone(event));
    record.state = event.outcome === 'cleared' ? 'active' : 'blocked';
    this.flush();
    return structuredClone(record);
  }

  erase(id: string, reason: string, at = Date.now()): boolean {
    if (!this.data.records[id]) return false;
    delete this.data.records[id];
    this.data.erasures.push({ recordId: id, at, reason: reason.slice(0, 200) });
    this.flush();
    return true;
  }

  purgeExpired(now = Date.now()): number {
    const ids = Object.values(this.data.records).filter((record) => record.retentionUntil <= now).map((record) => record.id);
    for (const id of ids) {
      delete this.data.records[id];
      this.data.erasures.push({ recordId: id, at: now, reason: 'retention expired' });
    }
    if (ids.length) this.flush();
    return ids.length;
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = { erased: this.data.erasures.length };
    for (const record of Object.values(this.data.records)) out[record.state] = (out[record.state] ?? 0) + 1;
    return out;
  }

  private mustGet(id: string): VaultRecord {
    const record = this.data.records[id];
    if (!record) throw new Error(`unknown vault record ${id}`);
    return record;
  }

  private decrypt(raw: string): VaultData {
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.version !== 1) throw new Error(`unsupported evidence vault version ${envelope.version}`);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final(),
      ]);
      const parsed = JSON.parse(plaintext.toString('utf8')) as VaultData;
      if (parsed.version !== 1) throw new Error('bad plaintext version');
      return parsed;
    } catch {
      throw new Error('evidence vault authentication failed (wrong key or corrupt file)');
    }
  }

  private flush(): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()]);
    const envelope: Envelope = {
      version: 1,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
