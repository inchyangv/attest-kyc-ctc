import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { AmlEngine, Decision, ListId, ScreeningSubject } from './types.js';

export const HOLDOUT_REPORT_VERSION = 1;
export const HOLDOUT_EVALUATION_VERSION = 'aml-holdout-evaluation-1';

export type HoldoutTruth = 'POSITIVE' | 'NEGATIVE';
export type HoldoutClassification = 'internal-synthetic' | 'independent-holdout' | 'customer-approved';
export type HoldoutEntityType = 'individual' | 'entity' | 'vessel' | 'unknown';

export interface HoldoutCase {
  id: string;
  subject: ScreeningSubject;
  truth: HoldoutTruth;
  dimensions: {
    country: string;
    script: string;
    listId: ListId | 'NONE';
    entityType: HoldoutEntityType;
  };
  /** Human-readable evidence category, not the evidence itself or raw customer data. */
  labelBasis: string;
  /** Completed manual investigation time, when such an investigation actually occurred. */
  investigationMs?: number;
}

export interface HoldoutDataset {
  schemaVersion: 1;
  datasetId: string;
  datasetVersion: string;
  provenance: {
    classification: HoldoutClassification;
    independentlyLabeled: boolean;
    holdoutFromDevelopment: boolean;
    labelOwner: string;
    labelBasis: string;
    selectionProtocol?: string;
    containsPersonalData: boolean;
  };
  cases: HoldoutCase[];
}

export interface HoldoutThresholdPolicy {
  version: string;
  minimumCases: number;
  minimumPositiveCases?: number;
  minimumNegativeCases?: number;
  maximumFalseNegativeRate: number;
  maximumFalsePositiveRate: number;
  maximumReviewRate: number;
}

export interface ConfusionMatrix {
  total: number;
  positive: number;
  negative: number;
  truePositive: number;
  falseNegative: number;
  falsePositive: number;
  trueNegative: number;
  block: number;
  review: number;
  allow: number;
  falseNegativeRate: number | null;
  falsePositiveRate: number | null;
  reviewRate: number;
  falseNegativeWilson95: [number, number] | null;
  falsePositiveWilson95: [number, number] | null;
}

export interface HoldoutEvaluationReport {
  reportVersion: 1;
  evaluationVersion: string;
  engineVersion: string;
  generatedAt: string;
  dataset: {
    id: string;
    version: string;
    fingerprint: string;
    classification: HoldoutClassification;
    independentlyLabeled: boolean;
    holdoutFromDevelopment: boolean;
    labelOwner: string;
    labelBasis: string;
    selectionProtocol: string | null;
    containsPersonalData: boolean;
  };
  sourceSha256: Record<string, string>;
  thresholds: HoldoutThresholdPolicy;
  overall: ConfusionMatrix;
  byCountry: Record<string, ConfusionMatrix>;
  byScript: Record<string, ConfusionMatrix>;
  byList: Record<string, ConfusionMatrix>;
  byEntityType: Record<string, ConfusionMatrix>;
  investigation: {
    reviewed: number;
    reviewedWithTiming: number;
    totalMs: number;
    meanMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  /** Completeness of self-declared dataset metadata, never independent approval by itself. */
  independenceMetadataComplete: boolean;
  independenceMetadataGaps: string[];
  statisticalLimitations: string[];
  reportFingerprint: string;
}

interface Observation {
  truth: HoldoutTruth;
  decision: Decision;
  dimensions: HoldoutCase['dimensions'];
  investigationMs?: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function finiteRate(value: unknown, field: string): asserts value is number {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, `${field} must be between 0 and 1`);
}

export function validateHoldoutThresholdPolicy(policy: HoldoutThresholdPolicy): void {
  assert.ok(policy && typeof policy.version === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(policy.version), 'invalid threshold policy version');
  for (const field of ['minimumCases', 'minimumPositiveCases', 'minimumNegativeCases'] as const) {
    const value = policy[field];
    if (value !== undefined) assert.ok(Number.isSafeInteger(value) && value >= 0, `${field} must be a non-negative integer`);
  }
  assert.ok(policy.minimumCases > 0, 'minimumCases must be positive');
  finiteRate(policy.maximumFalseNegativeRate, 'maximumFalseNegativeRate');
  finiteRate(policy.maximumFalsePositiveRate, 'maximumFalsePositiveRate');
  finiteRate(policy.maximumReviewRate, 'maximumReviewRate');
}

export function validateHoldoutDataset(dataset: HoldoutDataset): void {
  assert.ok(dataset && dataset.schemaVersion === 1, 'unsupported holdout dataset schema');
  assert.match(dataset.datasetId, /^[a-z0-9][a-z0-9._-]{0,127}$/i, 'invalid dataset id');
  assert.match(dataset.datasetVersion, /^[a-z0-9][a-z0-9._-]{0,127}$/i, 'invalid dataset version');
  assert.ok(dataset.provenance && ['internal-synthetic', 'independent-holdout', 'customer-approved'].includes(dataset.provenance.classification), 'invalid dataset classification');
  assert.equal(typeof dataset.provenance.independentlyLabeled, 'boolean', 'independentlyLabeled must be boolean');
  assert.equal(typeof dataset.provenance.holdoutFromDevelopment, 'boolean', 'holdoutFromDevelopment must be boolean');
  assert.equal(typeof dataset.provenance.containsPersonalData, 'boolean', 'containsPersonalData must be boolean');
  assert.ok(dataset.provenance.labelOwner.trim(), 'dataset label owner is required');
  assert.ok(dataset.provenance.labelBasis.trim(), 'dataset label basis is required');
  assert.ok(Array.isArray(dataset.cases) && dataset.cases.length > 0, 'holdout dataset is empty');
  const ids = new Set<string>();
  for (const row of dataset.cases) {
    assert.ok(row && typeof row.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(row.id) && !ids.has(row.id), 'invalid or duplicate holdout case id');
    ids.add(row.id);
    assert.ok(row.subject && typeof row.subject.fullName === 'string' && typeof row.subject.dateOfBirth === 'string'
      && typeof row.subject.nationality === 'string' && typeof row.subject.residence === 'string'
      && typeof row.subject.walletAddress === 'string', `invalid subject for ${row.id}`);
    assert.ok(row.truth === 'POSITIVE' || row.truth === 'NEGATIVE', `invalid truth for ${row.id}`);
    assert.ok(row.dimensions && /^[A-Z]{2}$/.test(row.dimensions.country), `invalid country for ${row.id}`);
    assert.ok(/^[A-Za-z][A-Za-z0-9+._-]{0,63}$/.test(row.dimensions.script), `invalid script for ${row.id}`);
    assert.ok(['OFAC_SDN', 'UN_CONSOLIDATED', 'EU_FSF', 'NONE'].includes(row.dimensions.listId), `invalid list for ${row.id}`);
    assert.ok(['individual', 'entity', 'vessel', 'unknown'].includes(row.dimensions.entityType), `invalid entity type for ${row.id}`);
    assert.ok(typeof row.labelBasis === 'string' && row.labelBasis.trim().length > 0, `label basis required for ${row.id}`);
    if (row.investigationMs !== undefined) assert.ok(Number.isSafeInteger(row.investigationMs) && row.investigationMs >= 0, `invalid investigation time for ${row.id}`);
  }
}

function wilson95(events: number, total: number): [number, number] | null {
  if (!total) return null;
  const z = 1.959963984540054;
  const p = events / total;
  const denominator = 1 + z * z / total;
  const centre = (p + z * z / (2 * total)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

function matrix(rows: Observation[]): ConfusionMatrix {
  const positive = rows.filter(row => row.truth === 'POSITIVE').length;
  const negative = rows.length - positive;
  const truePositive = rows.filter(row => row.truth === 'POSITIVE' && row.decision !== 'ALLOW').length;
  const falseNegative = positive - truePositive;
  const falsePositive = rows.filter(row => row.truth === 'NEGATIVE' && row.decision !== 'ALLOW').length;
  const trueNegative = negative - falsePositive;
  const block = rows.filter(row => row.decision === 'BLOCK').length;
  const review = rows.filter(row => row.decision === 'REVIEW').length;
  const allow = rows.length - block - review;
  return {
    total: rows.length, positive, negative, truePositive, falseNegative, falsePositive, trueNegative, block, review, allow,
    falseNegativeRate: positive ? falseNegative / positive : null,
    falsePositiveRate: negative ? falsePositive / negative : null,
    reviewRate: rows.length ? review / rows.length : 0,
    falseNegativeWilson95: wilson95(falseNegative, positive),
    falsePositiveWilson95: wilson95(falsePositive, negative),
  };
}

function grouped(rows: Observation[], pick: (row: Observation) => string): Record<string, ConfusionMatrix> {
  const groups = new Map<string, Observation[]>();
  for (const row of rows) {
    const key = pick(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => [key, matrix(group)]));
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
}

export async function evaluateHoldout(
  dataset: HoldoutDataset,
  engine: AmlEngine,
  context: { engineVersion: string; sourceSha256: Record<string, string> },
  thresholds: HoldoutThresholdPolicy,
): Promise<HoldoutEvaluationReport> {
  validateHoldoutDataset(dataset);
  validateHoldoutThresholdPolicy(thresholds);
  assert.ok(context && typeof context.engineVersion === 'string' && context.engineVersion.trim(), 'engine version is required');
  assert.ok(context.sourceSha256 && Object.keys(context.sourceSha256).length > 0, 'source hashes are required');
  for (const [source, hash] of Object.entries(context.sourceSha256)) assert.ok(source && /^[0-9a-f]{64}$/.test(hash), `invalid source hash: ${source}`);

  const rows: Observation[] = [];
  for (const row of dataset.cases) {
    const result = await engine.screen(structuredClone(row.subject));
    assert.ok(['ALLOW', 'BLOCK', 'REVIEW'].includes(result.decision), `invalid matcher decision for ${row.id}`);
    rows.push({ truth: row.truth, decision: result.decision, dimensions: structuredClone(row.dimensions), investigationMs: row.investigationMs });
  }
  const overall = matrix(rows);
  const reviewTimes = rows.filter(row => row.decision === 'REVIEW' && row.investigationMs !== undefined).map(row => row.investigationMs!);
  const independenceMetadataGaps: string[] = [];
  if (dataset.provenance.classification !== 'independent-holdout') independenceMetadataGaps.push('dataset is not classified as an independent holdout');
  if (!dataset.provenance.independentlyLabeled) independenceMetadataGaps.push('dataset is not independently labelled');
  if (!dataset.provenance.holdoutFromDevelopment) independenceMetadataGaps.push('dataset was not held out from matcher development');
  if (!dataset.provenance.selectionProtocol?.trim()) independenceMetadataGaps.push('sampling/selection protocol is not recorded');
  const limitations = [
    'Rates describe only the supplied labelled cases and do not establish population performance or legal compliance.',
    'BLOCK and REVIEW are both counted as a positive hold; this report separately exposes the REVIEW workload.',
    'Wilson intervals quantify binomial sampling uncertainty only and do not correct label, selection, temporal, or distribution bias.',
  ];
  for (const [dimension, groups] of Object.entries({ country: grouped(rows, row => row.dimensions.country), script: grouped(rows, row => row.dimensions.script), list: grouped(rows, row => row.dimensions.listId), entityType: grouped(rows, row => row.dimensions.entityType) })) {
    if (Object.values(groups).some(group => group.total < 30)) limitations.push(`${dimension} includes strata below 30 cases; those rates are descriptive only.`);
  }
  if (overall.review > reviewTimes.length) limitations.push('Investigation time is missing for one or more REVIEW outcomes.');

  const reportWithoutFingerprint = {
    reportVersion: HOLDOUT_REPORT_VERSION as 1,
    evaluationVersion: HOLDOUT_EVALUATION_VERSION,
    engineVersion: context.engineVersion,
    generatedAt: new Date().toISOString(),
    dataset: {
      id: dataset.datasetId,
      version: dataset.datasetVersion,
      fingerprint: fingerprint(dataset),
      classification: dataset.provenance.classification,
      independentlyLabeled: dataset.provenance.independentlyLabeled,
      holdoutFromDevelopment: dataset.provenance.holdoutFromDevelopment,
      labelOwner: dataset.provenance.labelOwner,
      labelBasis: dataset.provenance.labelBasis,
      selectionProtocol: dataset.provenance.selectionProtocol?.trim() || null,
      containsPersonalData: dataset.provenance.containsPersonalData,
    },
    sourceSha256: Object.fromEntries(Object.entries(context.sourceSha256).sort(([a], [b]) => a.localeCompare(b))),
    thresholds: structuredClone(thresholds),
    overall,
    byCountry: grouped(rows, row => row.dimensions.country),
    byScript: grouped(rows, row => row.dimensions.script),
    byList: grouped(rows, row => row.dimensions.listId),
    byEntityType: grouped(rows, row => row.dimensions.entityType),
    investigation: {
      reviewed: overall.review,
      reviewedWithTiming: reviewTimes.length,
      totalMs: reviewTimes.reduce((sum, value) => sum + value, 0),
      meanMs: reviewTimes.length ? reviewTimes.reduce((sum, value) => sum + value, 0) / reviewTimes.length : null,
      p50Ms: percentile(reviewTimes, 0.5),
      p95Ms: percentile(reviewTimes, 0.95),
    },
    independenceMetadataComplete: independenceMetadataGaps.length === 0,
    independenceMetadataGaps,
    statisticalLimitations: [...new Set(limitations)],
  };
  return { ...reportWithoutFingerprint, reportFingerprint: fingerprint(reportWithoutFingerprint) };
}

export function assertHoldoutThresholds(report: HoldoutEvaluationReport, policy = report.thresholds): void {
  validateHoldoutThresholdPolicy(policy);
  assert.deepEqual(report.thresholds, policy, 'report threshold policy differs');
  assert.ok(report.overall.total >= policy.minimumCases, `sample size ${report.overall.total} is below ${policy.minimumCases}`);
  assert.ok(report.overall.positive >= (policy.minimumPositiveCases ?? 1), 'positive sample is too small');
  assert.ok(report.overall.negative >= (policy.minimumNegativeCases ?? 1), 'negative sample is too small');
  assert.ok(report.overall.falseNegativeRate !== null && report.overall.falseNegativeRate <= policy.maximumFalseNegativeRate,
    `false-negative rate ${report.overall.falseNegativeRate ?? 'unavailable'} exceeds ${policy.maximumFalseNegativeRate}`);
  assert.ok(report.overall.falsePositiveRate !== null && report.overall.falsePositiveRate <= policy.maximumFalsePositiveRate,
    `false-positive rate ${report.overall.falsePositiveRate ?? 'unavailable'} exceeds ${policy.maximumFalsePositiveRate}`);
  assert.ok(report.overall.reviewRate <= policy.maximumReviewRate,
    `review rate ${report.overall.reviewRate} exceeds ${policy.maximumReviewRate}`);
}
