import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const EVALUATION_POLICY_VERSION = 'aml-internal-regression-1';
export const INTERNAL_EVALUATION_THRESHOLDS = Object.freeze({
  minimumPositiveCount: 200,
  maximumMissed: 0,
  minimumCleanCount: 610,
  maximumFalsePositive: 0,
  minimumEvasionCount: 7,
  maximumEvasionMissed: 0,
  walletMustBlock: true,
  maximumUnearnedBits: 0,
});
export interface EvaluationMetrics {
  positiveCount: number;
  missed: number;
  cleanCount: number;
  falsePositive: number;
  evasionCount: number;
  evasionMissed: number;
  walletBlocked: boolean;
  unearnedBits: number;
}

/** Frozen INTERNAL regression expectations, not a market recall/specificity warranty. */
export function assertEvaluation(metrics: EvaluationMetrics): void {
  for (const [key, value] of Object.entries(metrics)) if (key !== 'walletBlocked') {
    assert.ok(Number.isSafeInteger(value) && Number(value) >= 0, `invalid metric: ${key}`);
  }
  assert.ok(metrics.positiveCount >= INTERNAL_EVALUATION_THRESHOLDS.minimumPositiveCount, 'positive sample is too small');
  assert.ok(metrics.cleanCount >= INTERNAL_EVALUATION_THRESHOLDS.minimumCleanCount, 'clean sample is too small');
  assert.ok(metrics.evasionCount >= INTERNAL_EVALUATION_THRESHOLDS.minimumEvasionCount, 'normalization regression sample is too small');
  assert.equal(metrics.missed, INTERNAL_EVALUATION_THRESHOLDS.maximumMissed, 'listed positive escaped BLOCK/REVIEW');
  assert.equal(metrics.falsePositive, INTERNAL_EVALUATION_THRESHOLDS.maximumFalsePositive, 'internal clean regression unexpectedly held');
  assert.equal(metrics.evasionMissed, INTERNAL_EVALUATION_THRESHOLDS.maximumEvasionMissed, 'normalization variant escaped BLOCK/REVIEW');
  assert.equal(metrics.walletBlocked, INTERNAL_EVALUATION_THRESHOLDS.walletMustBlock, 'listed wallet did not block');
  assert.equal(metrics.unearnedBits, INTERNAL_EVALUATION_THRESHOLDS.maximumUnearnedBits, 'unperformed screening bits were set');
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

function wilsonUpper95(events: number, total: number): number | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = events / total;
  const denominator = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return Math.min(1, centre + margin);
}

export function buildInternalEvaluationReport(input: {
  engineVersion: string;
  sourceSha256: Record<string, string>;
  listCounts: Record<string, number>;
  historical: boolean;
  blocked: number;
  reviewed: number;
  metrics: EvaluationMetrics;
  generatedAt?: string;
}) {
  assertEvaluation(input.metrics);
  assert.ok(input.engineVersion.trim(), 'engine version is required');
  assert.ok(Object.keys(input.sourceSha256).length > 0 && Object.values(input.sourceSha256).every(hash => /^[0-9a-f]{64}$/.test(hash)), 'valid source hashes are required');
  assert.equal(input.blocked + input.reviewed + input.metrics.missed, input.metrics.positiveCount, 'positive outcome counts differ');
  const body = {
    reportVersion: 1,
    evaluationPolicyVersion: EVALUATION_POLICY_VERSION,
    engineVersion: input.engineVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    freshnessMode: input.historical ? 'historical-regression-only' : 'fresh-manifest-required',
    sourceSha256: Object.fromEntries(Object.entries(input.sourceSha256).sort(([a], [b]) => a.localeCompare(b))),
    listCounts: Object.fromEntries(Object.entries(input.listCounts).sort(([a], [b]) => a.localeCompare(b))),
    sampleGeneration: {
      positives: 'Deterministic parser-order interval sample of 200 list entries that are individuals with DOB, country, and at least two name tokens; sampled from the matcher source corpus.',
      negatives: 'Fixed Cartesian product of 30 Korean surnames and 20 given names plus 10 English names; internally authored and not independently labelled.',
      evasions: 'Seven fixed normalization variants of the first eligible Latin-script source entry.',
    },
    thresholds: INTERNAL_EVALUATION_THRESHOLDS,
    outcomes: { blocked: input.blocked, reviewed: input.reviewed, ...input.metrics,
      reviewRateAmongPositives: input.reviewed / input.metrics.positiveCount,
      falseNegativeWilson95Upper: wilsonUpper95(input.metrics.missed, input.metrics.positiveCount),
      falsePositiveWilson95Upper: wilsonUpper95(input.metrics.falsePositive, input.metrics.cleanCount) },
    classification: 'internal-regression-not-independent-holdout',
    statisticalLimitations: [
      'Positive cases are sampled from the same source corpus used by the matcher, so the result is not out-of-sample recall.',
      'Clean cases are synthetic and Korean-heavy, so the result is not a customer false-positive estimate.',
      'The seven evasion cases target one source name and do not estimate multilingual or adversarial recall.',
      'Wilson bounds cover binomial sampling uncertainty only; selection, label, temporal, and distribution bias remain.',
      'No manual investigation workload, customer corpus, legal decision threshold, or independent evaluator is represented.',
    ],
  };
  return { ...body, reportFingerprint: createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex') };
}
