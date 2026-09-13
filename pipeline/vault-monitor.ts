import { ethers } from 'ethers';
import type { VaultState } from './vault.js';

export interface VaultMonitorSnapshot {
  records: { id: string; state: VaultState; createdAt: number; retentionUntil: number; lastScreenedAt?: number; sourceObserved: boolean }[];
  revocations: { id: string; recordId: string; state: 'pending' | 'prepared' | 'confirmed'; createdAt: number; confirmedAt?: number;
    hasError: boolean; latestObservation?: { state: string; observedAt: number } }[];
}
export interface VaultMonitorLimits {
  screeningIntervalMs: number;
  pendingIssuanceMs: number;
  reviewRecordAgeMs: number;
  revocationMs: number;
  observationMaxAgeMs: number;
}
const valid = (value: number) => Number.isSafeInteger(value) && value >= 0;
const demand = (ok: unknown) => { if (!ok) throw new Error('INVALID_MONITOR_STATE_OR_LIMITS'); };

/** Local backlog diagnostics only. No RPC, liveness assertion, authorization, rescreen or deletion. */
export function monitorVault(snapshot: VaultMonitorSnapshot, limits: VaultMonitorLimits, now = Date.now()) {
  demand(valid(now));
  for (const name of ['screeningIntervalMs', 'pendingIssuanceMs', 'reviewRecordAgeMs', 'revocationMs', 'observationMaxAgeMs'] as const) {
    demand(valid(limits[name]) && limits[name] > 0);
  }
  const findings: { caseDigest: string; kind: 'record' | 'revocation'; code: string; ageMs?: number }[] = [];
  const counts: Record<string, number> = {};
  let findingCount = 0;
  const add = (id: string, kind: 'record' | 'revocation', code: string, ageMs?: number) => {
    findingCount++; counts[code] = (counts[code] ?? 0) + 1;
    if (findings.length < 100) findings.push({ caseDigest: ethers.id(id), kind, code, ...(ageMs === undefined ? {} : { ageMs }) });
  };
  const jobsByRecord = new Set(snapshot.revocations.map(job => job.recordId));
  const recordStates: Record<string, number> = {};
  for (const record of snapshot.records) {
    demand(typeof record.id === 'string' && record.id.length > 0 && valid(record.createdAt) && record.createdAt <= now
      && valid(record.retentionUntil) && record.retentionUntil >= record.createdAt
      && (record.lastScreenedAt === undefined || (valid(record.lastScreenedAt) && record.lastScreenedAt <= now && record.lastScreenedAt >= record.createdAt))
      && typeof record.sourceObserved === 'boolean' && ['pending', 'active', 'review', 'blocked', 'rejected'].includes(record.state));
    recordStates[record.state] = (recordStates[record.state] ?? 0) + 1;
    const age = now - record.createdAt;
    if (record.state === 'pending' && age >= limits.pendingIssuanceMs) add(record.id, 'record', record.sourceObserved ? 'HUB_MATERIALIZATION_PENDING' : 'ISSUANCE_UNRECONCILED', age);
    // This is deliberately record age, not time since entering REVIEW or an institutional SLA.
    if (record.state === 'review' && age >= limits.reviewRecordAgeMs) add(record.id, 'record', 'REVIEW_RECORD_AGE', age);
    if (['active', 'review', 'pending'].includes(record.state) && record.retentionUntil <= now) {
      add(record.id, 'record', 'RETAINED_RECORD_OUTSIDE_SCREENING', now - record.retentionUntil);
    } else if (record.state === 'active' || record.state === 'review' || (record.state === 'pending' && record.sourceObserved)) {
      const since = record.lastScreenedAt;
      if (since === undefined || now - since >= limits.screeningIntervalMs) add(record.id, 'record', 'SCREENING_DUE', since === undefined ? age : now - since);
    }
    if (record.state === 'blocked' && !jobsByRecord.has(record.id)) add(record.id, 'record', 'BLOCK_WITHOUT_REVOCATION', age);
  }
  const revocationStates: Record<string, number> = {};
  for (const job of snapshot.revocations) {
    demand(typeof job.id === 'string' && job.id.length > 0 && typeof job.recordId === 'string'
      && valid(job.createdAt) && job.createdAt <= now && ['pending', 'prepared', 'confirmed'].includes(job.state)
      && typeof job.hasError === 'boolean');
    revocationStates[job.state] = (revocationStates[job.state] ?? 0) + 1;
    if (job.state !== 'confirmed') {
      if (now - job.createdAt >= limits.revocationMs) add(job.id, 'revocation', 'REVOCATION_OVERDUE', now - job.createdAt);
      if (job.hasError) add(job.id, 'revocation', 'REVOCATION_ERROR');
    } else {
      demand(job.confirmedAt !== undefined && valid(job.confirmedAt) && job.confirmedAt >= job.createdAt && job.confirmedAt <= now);
      if (!job.latestObservation && now - job.confirmedAt! >= limits.observationMaxAgeMs) add(job.id, 'revocation', 'HUB_OBSERVATION_MISSING', now - job.confirmedAt!);
    }
    const observed = job.latestObservation;
    if (observed) {
      demand(valid(observed.observedAt) && observed.observedAt <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
        && observed.observedAt * 1000 <= now && ['ENFORCED', 'AWAITING_HUB', 'SUPERSEDED', 'INCONSISTENT'].includes(observed.state));
      if (observed.state !== 'ENFORCED') add(job.id, 'revocation', `LAST_OBSERVATION_${observed.state}`);
      if (now - observed.observedAt * 1000 >= limits.observationMaxAgeMs) add(job.id, 'revocation', 'HUB_OBSERVATION_STALE', now - observed.observedAt * 1000);
    }
  }
  return { version: 1, observedAt: now, scope: 'local-vault-snapshot', currentEnforcement: 'NOT_CHECKED', processLiveness: 'NOT_CHECKED',
    status: findingCount ? 'ATTENTION_REQUIRED' : 'NO_LOCAL_FINDINGS', limits: { screeningIntervalMs: limits.screeningIntervalMs,
      pendingIssuanceMs: limits.pendingIssuanceMs, reviewRecordAgeMs: limits.reviewRecordAgeMs,
      revocationMs: limits.revocationMs, observationMaxAgeMs: limits.observationMaxAgeMs },
    totals: { records: snapshot.records.length, revocations: snapshot.revocations.length }, recordStates, revocationStates,
    findingCount, counts, findings, findingsTruncated: findingCount > 100 };
}
