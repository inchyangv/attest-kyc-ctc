import 'server-only';
import { EvidenceVault, type VaultRecord, type VaultState } from '@pipeline/vault.js';
import type { IssueOutcome, IssueRequest } from '@pipeline/issue.js';
import { ConfigError } from './kyc-server';
import type { IssuanceEntry } from '@pipeline/issuance-journal.js';
import { issuanceEvidenceSink as makeEvidenceSink } from '@pipeline/issuance-evidence.js';
import { IssuanceJournalError } from '@pipeline/issuance-journal.js';
import { getEngine } from './aml-server';
import { retentionPolicyEvidence, type RetentionPolicyV1, type RetentionOutcome } from '@pipeline/retention-policy.js';

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;

export type VaultStatus = { configured: boolean; persistent: boolean; missing: string[]; mode: 'file' | 'none' };

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

export function buildEvidenceRecord(
  id: string,
  req: IssueRequest,
  outcome: IssueOutcome,
  consentVersion: string,
  processingPolicy: NonNullable<IssueRequest['processingPolicy']>,
  retentionPolicy: RetentionPolicyV1,
  now = Date.now(),
): VaultRecord | undefined {
  const status = evidenceVaultStatus();
  if (!status.configured) {
    if (retentionPolicy.status === 'synthetic') return undefined; // Encrypted short-term issuance journal is still mandatory.
    throw new ConfigError('production issuance requires a persistent encrypted evidence vault', status.missing);
  }

  const state: VaultState = outcome.status === 'ISSUED' ? 'pending'
    : outcome.status === 'REVIEW' ? 'review'
      : outcome.status === 'DENIED' ? 'blocked' : 'rejected';
  const issued = outcome.status === 'ISSUED' ? outcome : null;
  const retentionOutcome: RetentionOutcome = outcome.status === 'ISSUED' ? 'issued'
    : outcome.status === 'REVIEW' ? 'review' : outcome.status === 'DENIED' ? 'denied' : 'error';
  const retention = retentionPolicyEvidence(retentionPolicy, {
    customerId: processingPolicy.customerId, jurisdiction: 'KR', outcome: retentionOutcome,
    collectedAt: now, decisionAt: now,
  });
  return {
    id,
    walletAddress: req.wallet,
    consentVersion,
    processingPolicy,
    retentionPolicy: retention,
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
    retentionUntil: retention.vaultDeleteAt,
    lastScreenedAt: outcome.status === 'ISSUED' || outcome.status === 'DENIED' || outcome.status === 'REVIEW' ? now : undefined,
    rescreens: [],
    reviews: [],
  };
}

function retained(entry: IssuanceEntry): EvidenceVault | null {
  if (!entry.evidenceRecord) return null;
  const status = evidenceVaultStatus();
  if (!status.configured) throw new ConfigError('retained evidence vault is unavailable; issuance cannot resume', status.missing);
  return configuredVault();
}

function assertCurrentScreening(entry: IssuanceEntry): void {
  if (entry.outcome.status !== 'ISSUED') return;
  const prepared = entry.outcome.screeningSnapshotId;
  if (!prepared) throw new IssuanceJournalError('SANCTIONS_SNAPSHOT_UNAVAILABLE');
  const current = getEngine('issuance').meta.provenance.snapshotId;
  if (prepared !== current) throw new IssuanceJournalError('SANCTIONS_SNAPSHOT_CHANGED');
}

export const issuanceEvidenceSink = makeEvidenceSink(retained, assertCurrentScreening);
