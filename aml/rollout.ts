import { createHash } from 'node:crypto';
import { readIndex } from './index-format.js';
import { FATF, assertJurisdictionTable } from './jurisdiction.js';
import { assertProvenance, freshnessHoursFor, sha256, type SanctionsUse } from './provenance.js';

export const SANCTIONS_RUNTIME_SCOPES = ['web-screen', 'web-issuance', 'rescreen', 'worker-relay'] as const;
export type SanctionsRuntimeScope = typeof SANCTIONS_RUNTIME_SCOPES[number];
export type SanctionsFreshnessPolicy = Record<SanctionsUse, number>;
export interface SanctionsRolloutPlan {
  version: 1;
  releaseId: string;
  snapshotId: string;
  previousSnapshotId: string | null;
  indexSha256: string;
  fatfSnapshotId: string;
  freshnessHours: SanctionsFreshnessPolicy;
  createdAt: string;
}
export interface SanctionsRuntimeObservation {
  version: 1;
  runtime: SanctionsRuntimeScope;
  releaseId: string;
  snapshotId: string;
  indexSha256: string | null;
  fatfSnapshotId: string;
  freshnessHours: SanctionsFreshnessPolicy;
  observedAt: string;
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const exactKeys = (value: object, keys: string[]) => Object.keys(value).sort().join() === [...keys].sort().join();
const id = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const instant = (value: unknown): number => {
  if (typeof value !== 'string') return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
};
const policy = (env: NodeJS.ProcessEnv): SanctionsFreshnessPolicy => {
  const names = ['SANCTIONS_SCREEN_MAX_AGE_HOURS', 'SANCTIONS_ISSUANCE_MAX_AGE_HOURS',
    'SANCTIONS_RESCREEN_MAX_AGE_HOURS', 'SANCTIONS_EPOCH_MAX_AGE_HOURS'] as const;
  if (names.some(name => !env[name]?.trim())) throw new Error('SANCTIONS_ROLLOUT_PURPOSE_POLICY_REQUIRED');
  return { screen: freshnessHoursFor('screen', env), issuance: freshnessHoursFor('issuance', env),
    rescreen: freshnessHoursFor('rescreen', env), epoch: freshnessHoursFor('epoch', env) };
};

export function createSanctionsRolloutPlan(
  index: Buffer,
  previousSnapshotId: string | null,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): SanctionsRolloutPlan {
  if (previousSnapshotId !== null && !id(previousSnapshotId)) throw new Error('SANCTIONS_ROLLOUT_PREVIOUS_SNAPSHOT_INVALID');
  const { meta } = readIndex(index, now), freshnessHours = policy(env);
  for (const maxAge of Object.values(freshnessHours)) assertProvenance(meta.provenance, now, maxAge);
  assertJurisdictionTable(FATF, now);
  const body = { version: 1 as const, snapshotId: meta.provenance.snapshotId, previousSnapshotId,
    indexSha256: sha256(index), fatfSnapshotId: FATF.snapshotId, freshnessHours, createdAt: new Date(now).toISOString() };
  return { ...body, releaseId: digest(body) };
}

function assertPlan(value: SanctionsRolloutPlan, now: number): void {
  const { releaseId, ...body } = value;
  if (!exactKeys(value, ['version', 'releaseId', 'snapshotId', 'previousSnapshotId', 'indexSha256', 'fatfSnapshotId', 'freshnessHours', 'createdAt'])
    || value.version !== 1 || !id(releaseId) || releaseId !== digest(body) || !id(value.snapshotId) || !id(value.indexSha256)
    || !id(value.fatfSnapshotId) || (value.previousSnapshotId !== null && !id(value.previousSnapshotId))
    || !exactKeys(value.freshnessHours, ['screen', 'issuance', 'rescreen', 'epoch'])
    || Object.values(value.freshnessHours).some(age => !Number.isFinite(age) || age <= 0 || age > 168)
    || !Number.isFinite(instant(value.createdAt)) || instant(value.createdAt) > now) throw new Error('SANCTIONS_ROLLOUT_PLAN_INVALID');
}

/** Pure fail-closed fleet gate. It sends no alert and performs no deployment or rescreen transaction. */
export function assessSanctionsRollout(
  plan: SanctionsRolloutPlan,
  observations: SanctionsRuntimeObservation[],
  rescreenState: unknown,
  now = Date.now(),
  maxObservationAgeMs = 15 * 60_000,
) {
  assertPlan(plan, now);
  if (!Number.isSafeInteger(maxObservationAgeMs) || maxObservationAgeMs <= 0) throw new Error('SANCTIONS_ROLLOUT_OBSERVATION_POLICY_INVALID');
  const findings: Record<string, number> = {};
  const add = (code: string) => { findings[code] = (findings[code] ?? 0) + 1; };
  const seen = new Set<string>();
  for (const observation of observations) {
    if (!observation || !SANCTIONS_RUNTIME_SCOPES.includes(observation.runtime) || seen.has(observation.runtime)) { add('RUNTIME_OBSERVATION_INVALID'); continue; }
    seen.add(observation.runtime);
    const at = instant(observation.observedAt);
    if (!exactKeys(observation, ['version', 'runtime', 'releaseId', 'snapshotId', 'indexSha256', 'fatfSnapshotId', 'freshnessHours', 'observedAt'])
      || observation.version !== 1 || !Number.isFinite(at) || at > now || now - at > maxObservationAgeMs) add('RUNTIME_OBSERVATION_INVALID');
    if (observation.releaseId !== plan.releaseId || observation.snapshotId !== plan.snapshotId
      || observation.fatfSnapshotId !== plan.fatfSnapshotId || digest(observation.freshnessHours) !== digest(plan.freshnessHours)) add('RUNTIME_RELEASE_MISMATCH');
    const needsIndex = observation.runtime !== 'worker-relay';
    if ((needsIndex && observation.indexSha256 !== plan.indexSha256) || (!needsIndex && observation.indexSha256 !== null)) add('RUNTIME_INDEX_MISMATCH');
  }
  for (const runtime of SANCTIONS_RUNTIME_SCOPES) if (!seen.has(runtime)) add('RUNTIME_MISSING');
  if (plan.previousSnapshotId !== null && plan.previousSnapshotId !== plan.snapshotId) {
    const state = rescreenState as { version?: unknown; sanctionsSnapshotId?: unknown; phase?: unknown } | null;
    if (!state || state.version !== 2 || state.sanctionsSnapshotId !== plan.snapshotId || !['running', 'succeeded'].includes(String(state.phase))) add('RESCREEN_TRIGGER_NOT_OBSERVED');
  }
  const findingCount = Object.values(findings).reduce((sum, count) => sum + count, 0);
  return { version: 1, scope: 'sanctions-rollout-local-gate', releaseId: plan.releaseId, snapshotId: plan.snapshotId,
    status: findingCount ? 'ATTENTION_REQUIRED' : 'LOCAL_EVIDENCE_COMPLETE', findingCount, findings,
    alertDelivery: 'NOT_CONFIGURED', deployment: 'NOT_PERFORMED', legalApproval: 'NOT_CHECKED' };
}
