import 'server-only';
import { EvidenceVault, type VaultRecord, type VaultState } from '@pipeline/vault.js';
import type { IssueOutcome, IssueRequest } from '@pipeline/issue.js';
import { ConfigError } from './kyc-server';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export type VaultStatus = { configured: boolean; persistent: boolean; missing: string[]; mode: 'file' | 'none' };

export class EvidenceReplayError extends Error {
  constructor(readonly recordId: string) {
    super('this verification flow already has a final evidence record; start a new consented flow');
    this.name = 'EvidenceReplayError';
  }
}

let cached: { path: string; secret: string; vault: EvidenceVault } | null = null;

function configuredVault(): EvidenceVault {
  const path = env('EVIDENCE_VAULT_PATH')!;
  const secret = env('EVIDENCE_VAULT_KEY')!;
  if (!cached || cached.path !== path || cached.secret !== secret) {
    cached = { path, secret, vault: new EvidenceVault(path, secret) };
  }
  return cached.vault;
}

export function evidenceVaultStatus(): VaultStatus {
  const missing = ['EVIDENCE_VAULT_PATH', 'EVIDENCE_VAULT_KEY'].filter((name) => !env(name));
  return {
    configured: missing.length === 0 && !process.env.VERCEL,
    persistent: missing.length === 0 && !process.env.VERCEL,
    missing: process.env.VERCEL && missing.length === 0 ? ['persistent vault service (Vercel filesystem is ephemeral)'] : missing,
    mode: missing.length === 0 && !process.env.VERCEL ? 'file' : 'none',
  };
}

export function storeEvidenceRecord(
  id: string,
  req: IssueRequest,
  outcome: IssueOutcome,
  consentVersion: string,
  demo: boolean,
  now = Date.now(),
): { stored: boolean; mode: 'file' | 'none'; recordId: string; reason?: string } {
  const status = evidenceVaultStatus();
  if (!status.configured) {
    if (demo) return { stored: false, mode: 'none', recordId: id, reason: 'public sandbox keeps no server-side evidence' };
    throw new ConfigError('production issuance requires a persistent encrypted evidence vault', status.missing);
  }

  const retentionDays = Number(env('EVIDENCE_RETENTION_DAYS') ?? '1825');
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new ConfigError('EVIDENCE_RETENTION_DAYS must be a positive integer', ['EVIDENCE_RETENTION_DAYS']);
  }
  const state: VaultState = outcome.status === 'ISSUED' ? 'active'
    : outcome.status === 'REVIEW' ? 'review'
      : outcome.status === 'DENIED' ? 'blocked' : 'rejected';
  const issued = outcome.status === 'ISSUED' ? outcome : null;
  const record: VaultRecord = {
    id,
    walletAddress: req.wallet,
    consentVersion,
    screeningSubject: {
      fullName: req.declared.fullName,
      dateOfBirth: req.declared.dateOfBirth,
      nationality: req.declared.nationality,
      residence: req.declared.residence,
      walletAddress: req.wallet,
    },
    evidenceHash: outcome.evidenceHash,
    evidence: outcome.evidence,
    attrs: issued?.attrs,
    claimsRoot: issued?.claimsRoot,
    claims: issued?.claims,
    state,
    createdAt: now,
    retentionUntil: now + retentionDays * 86_400_000,
    lastScreenedAt: outcome.status === 'ISSUED' || outcome.status === 'DENIED' || outcome.status === 'REVIEW' ? now : undefined,
    rescreens: [],
    reviews: [],
  };
  const evidenceVault = configuredVault();
  if (evidenceVault.get(id)) throw new EvidenceReplayError(id);
  evidenceVault.put(record);
  return { stored: true, mode: 'file', recordId: id };
}
