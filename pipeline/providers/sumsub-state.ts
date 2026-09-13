import { retainSumsubWebhookFence, type SumsubEnvironment, type SumsubEvidenceCandidate } from './sumsub.js';

export interface SumsubSessionRecord {
  version: 1;
  revision: number;
  externalUserId: string;
  environment: SumsubEnvironment;
  walletAddress: string;
  flowId: string;
  levelName: string;
  identityPolicyId: string;
  processingPolicyFingerprint: string;
  retentionPolicyFingerprint: string;
  createdAt: number;
  expiresAt: number;
  latest?: SumsubEvidenceCandidate;
}

export type SumsubWebhookClaim = 'fresh' | 'duplicate' | 'stale' | 'conflict';

export interface SumsubStateStore {
  create(record: SumsubSessionRecord): Promise<'fresh' | 'existing' | 'conflict'>;
  get(externalUserId: string): Promise<SumsubSessionRecord | null>;
  saveObservation(externalUserId: string, evidence: SumsubEvidenceCandidate, expectedRevision: number): Promise<SumsubEvidenceCandidate>;
  applyWebhook(externalUserId: string, digest: string, eventAt: number, applicantId: string,
    evidence: SumsubEvidenceCandidate): Promise<SumsubWebhookClaim>;
}

export class InMemorySumsubStateStore implements SumsubStateStore {
  private readonly records = new Map<string, SumsubSessionRecord>();
  private readonly webhooks = new Map<string, { digest: string; eventAt: number; applicantId: string }>();
  async create(record: SumsubSessionRecord): Promise<'fresh' | 'existing' | 'conflict'> {
    const prior = this.records.get(record.externalUserId);
    if (!prior) { this.records.set(record.externalUserId, structuredClone(record)); return 'fresh'; }
    const same = prior.walletAddress.toLowerCase() === record.walletAddress.toLowerCase() && prior.flowId === record.flowId
      && prior.environment === record.environment && prior.levelName === record.levelName
      && prior.identityPolicyId === record.identityPolicyId
      && prior.processingPolicyFingerprint === record.processingPolicyFingerprint
      && prior.retentionPolicyFingerprint === record.retentionPolicyFingerprint;
    return same ? 'existing' : 'conflict';
  }
  async get(externalUserId: string): Promise<SumsubSessionRecord | null> {
    const value = this.records.get(externalUserId); return value ? structuredClone(value) : null;
  }
  async saveObservation(externalUserId: string, evidence: SumsubEvidenceCandidate, expectedRevision: number): Promise<SumsubEvidenceCandidate> {
    const value = this.records.get(externalUserId); if (!value) throw new Error('SUMSUB_SESSION_NOT_FOUND');
    if (value.revision !== expectedRevision) throw new Error('SUMSUB_REVISION_CONFLICT');
    const merged = retainSumsubWebhookFence(evidence, value.latest);
    // Match the production atomic fence: a callback newer than the provider review cannot be
    // cleared by a stale concurrent status write.
    if (value.latest?.webhookFence && merged.webhookFence?.eventAt !== value.latest.webhookFence.eventAt
      && (evidence.providerReviewedAt ?? 0) < value.latest.webhookFence.eventAt) throw new Error('SUMSUB_STATUS_FENCED');
    value.latest = structuredClone(merged); value.revision++;
    return structuredClone(merged);
  }
  private claimWebhook(externalUserId: string, digest: string, eventAt: number, applicantId: string): SumsubWebhookClaim {
    const record = this.records.get(externalUserId); if (!record) return 'conflict';
    const exact = this.webhooks.get(`${externalUserId}\0${digest}`); if (exact) return 'duplicate';
    const latest = [...this.webhooks.entries()].filter(([key]) => key.startsWith(`${externalUserId}\0`))
      .map(([, value]) => value).sort((a, b) => b.eventAt - a.eventAt)[0];
    if (latest && latest.applicantId !== applicantId) return 'conflict';
    if (latest && eventAt <= latest.eventAt) return 'stale';
    this.webhooks.set(`${externalUserId}\0${digest}`, { digest, eventAt, applicantId }); return 'fresh';
  }
  async applyWebhook(externalUserId: string, digest: string, eventAt: number, applicantId: string,
    evidence: SumsubEvidenceCandidate): Promise<SumsubWebhookClaim> {
    const claim = this.claimWebhook(externalUserId, digest, eventAt, applicantId);
    if (claim === 'fresh') {
      const value = this.records.get(externalUserId)!;
      value.latest = structuredClone(retainSumsubWebhookFence(evidence, value.latest)); value.revision++;
    }
    return claim;
  }
}
