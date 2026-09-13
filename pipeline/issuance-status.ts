import type { IssuanceEntry } from './issuance-journal.js';

export type PolicyObservation = {
  status: 'observed';
  blockNumber: number;
  blockHash: string;
  observedAt: number;
  policies: { id: number; name: string; verified: boolean; reasonCodes: string[] }[];
} | { status: 'unavailable'; code: 'POLICY_STATUS_UNAVAILABLE' | 'REGISTRY_NOT_CONFIGURED' };

export interface IssuanceTrackingConfig {
  configured: boolean;
  sourceExpectedSeconds: [number, number] | null;
  hubExpectedSeconds: [number, number] | null;
  timeoutSeconds: number | null;
  supportUrl: string | null;
  missing: string[];
  invalid: string[];
}

const timing = (startedAt: number | undefined, range: [number, number] | null, now: number) => ({
  expectedSeconds: range,
  expectedBy: startedAt !== undefined && range ? startedAt + range[1] * 1000 : null,
  overdue: startedAt !== undefined && range ? now > startedAt + range[1] * 1000 : null,
});

/** A user-facing projection. Source success, historical hub materialization and a current
 * Registry policy verdict deliberately remain three separate facts. */
export function issuanceProgress(entry: IssuanceEntry, observation: PolicyObservation | null,
  tracking: IssuanceTrackingConfig, now = Date.now()) {
  const reverted = entry.phase === 'failed' && entry.lastError === 'SOURCE_REVERTED';
  const source = reverted
    ? { state: 'reverted' as const, blockNumber: entry.sourceConfirmation?.blockNumber ?? null, confirmedAt: entry.sourceConfirmation?.confirmedAt ?? null }
    : entry.sourceConfirmation
      ? { state: 'confirmed' as const, blockNumber: entry.sourceConfirmation.blockNumber, confirmedAt: entry.sourceConfirmation.confirmedAt }
      : entry.transaction
        ? { state: 'pending' as const, txHash: entry.transaction.hash, submittedAt: entry.broadcastAcceptedAt ?? null }
        : { state: 'not-submitted' as const };
  const attestation = entry.phase === 'materialized'
    ? { state: 'applied' as const, appliedAt: entry.materializedAt ?? null }
    : entry.sourceConfirmation && !reverted
      ? { state: 'waiting' as const }
      : { state: 'not-started' as const };
  const policies = observation?.status === 'observed' ? observation.policies : [];
  const readyPolicyIds = policies.filter(policy => policy.verified).map(policy => policy.id);
  const policy = attestation.state !== 'applied'
    ? { state: 'waiting-attestation' as const, policies: [] }
    : observation?.status === 'observed'
      ? { state: readyPolicyIds.length ? 'eligible' as const : 'ineligible' as const,
          blockNumber: observation.blockNumber, blockHash: observation.blockHash, observedAt: observation.observedAt, policies }
      : { state: 'unavailable' as const, code: observation?.code ?? 'POLICY_STATUS_UNAVAILABLE', policies: [] };
  const nextAction = reverted ? 'retry' : entry.phase === 'failed' ? 'start-new-request'
    : entry.phase === 'materialized' ? 'refresh-status' : 'resume';
  return {
    source,
    attestation,
    policy,
    nextAction,
    timing: {
      configured: tracking.configured,
      source: timing(entry.createdAt, tracking.sourceExpectedSeconds, now),
      attestation: timing(entry.sourceConfirmation?.confirmedAt, tracking.hubExpectedSeconds, now),
      timeoutAt: tracking.timeoutSeconds === null ? null : entry.createdAt + tracking.timeoutSeconds * 1000,
      timedOut: tracking.timeoutSeconds === null ? null : now > entry.createdAt + tracking.timeoutSeconds * 1000,
      supportUrl: tracking.supportUrl,
      missing: tracking.missing,
      invalid: tracking.invalid,
    },
    assetAction: {
      ready: attestation.state === 'applied' && readyPolicyIds.length > 0,
      readyPolicyIds,
      scope: 'Current Registry verdicts only. The asset must require one of these exact policy IDs and its transaction must still succeed.',
    },
  };
}
