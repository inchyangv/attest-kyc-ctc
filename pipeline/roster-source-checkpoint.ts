import fs from 'node:fs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { ethers } from 'ethers';
import { writeVaultEnvelope } from './vault-atomic.js';
import type { SourceReplayCheckpoint } from './roster-source.js';

const MAX_BYTES = 128 * 1024 * 1024;
const fail = (code: string): never => { throw new SourceCheckpointError(code); };

export class SourceCheckpointError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SourceCheckpointError'; }
}

export interface SourceCheckpointScope { chainId: bigint; source: string; deploymentTx: string }

/** Encrypted, scope-bound, single-writer checkpoint storage. The builder rechecks the stored
 * anchor against both RPCs before trusting the accumulated replay state. */
export class SourceCheckpointStore {
  private readonly scope: { chainId: string; source: string; deploymentTx: string };
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private readonly lockPath: string;
  private checkpoint?: SourceReplayCheckpoint;
  private lock?: number;
  private closed = false;

  constructor(private readonly path: string, secret: string, input: SourceCheckpointScope) {
    if (!path || !secret || secret.length < 32 || typeof input.chainId !== 'bigint' || input.chainId <= 0n ||
        !ethers.isAddress(input.source) || ethers.getAddress(input.source) === ethers.ZeroAddress ||
        !ethers.isHexString(input.deploymentTx, 32)) fail('SOURCE_CHECKPOINT_CONFIG');
    this.scope = { chainId: input.chainId.toString(), source: ethers.getAddress(input.source), deploymentTx: input.deploymentTx.toLowerCase() };
    this.key = createHash('sha256').update('proofmark-source-checkpoint-key-v1\0').update(secret).digest();
    this.aad = Buffer.from(`proofmark-source-checkpoint-v1\0${JSON.stringify(this.scope)}`);
    this.lockPath = `${path}.lock`;
    fs.mkdirSync(dirname(path), { recursive: true });
    try {
      this.lock = fs.openSync(this.lockPath, 'wx', 0o600);
      fs.writeFileSync(this.lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); fs.fsyncSync(this.lock);
    } catch {
      if (this.lock !== undefined) { try { fs.closeSync(this.lock); } catch {} this.lock = undefined; try { fs.unlinkSync(this.lockPath); } catch {} }
      return fail('SOURCE_CHECKPOINT_BUSY');
    }
    if (!fs.existsSync(path)) return;
    try {
      const stat = fs.lstatSync(path);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_BYTES) fail('SOURCE_CHECKPOINT_UNAVAILABLE');
      const envelope = JSON.parse(fs.readFileSync(path, 'utf8'));
      if (envelope.version !== 1 || typeof envelope.iv !== 'string' || typeof envelope.tag !== 'string' || typeof envelope.ciphertext !== 'string')
        fail('SOURCE_CHECKPOINT_UNAVAILABLE');
      const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64'));
      cipher.setAAD(this.aad); cipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      this.checkpoint = JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext, 'base64')), cipher.final()]).toString('utf8'));
      this.assertScope(this.checkpoint!);
    } catch {
      this.close(); fail('SOURCE_CHECKPOINT_UNAVAILABLE');
    }
  }

  private assertOpen(): void { if (this.closed) fail('SOURCE_CHECKPOINT_CLOSED'); }
  private assertScope(value: SourceReplayCheckpoint): void {
    if (!value || value.version !== 1 || value.chainId !== this.scope.chainId || value.source !== this.scope.source ||
        value.deploymentTx !== this.scope.deploymentTx) fail('SOURCE_CHECKPOINT_SCOPE');
  }
  load(): SourceReplayCheckpoint | undefined { this.assertOpen(); return this.checkpoint && structuredClone(this.checkpoint); }
  save(value: SourceReplayCheckpoint): void {
    this.assertOpen(); this.assertScope(value);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(this.aad);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') });
    if (Buffer.byteLength(envelope) > MAX_BYTES) fail('SOURCE_CHECKPOINT_CAPACITY');
    try { writeVaultEnvelope(this.path, envelope); }
    catch { return fail('SOURCE_CHECKPOINT_WRITE_UNCONFIRMED'); }
    this.checkpoint = structuredClone(value);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.lock !== undefined) { try { fs.closeSync(this.lock); } catch {} this.lock = undefined; try { fs.unlinkSync(this.lockPath); } catch {} }
  }
}
