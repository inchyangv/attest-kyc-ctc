import { createHash } from 'node:crypto';

import { canonicalJson } from './canonical.js';

export const RETENTION_POLICY_SCHEMA = 'proofmark-retention-policy-v1' as const;

export const RETENTION_LAYERS = [
  'evidence-vault', 'issuance-journal', 'revocation-outbox', 'backup',
  'vendor', 'operational-log', 'client-copy', 'onchain',
] as const;

export type RetentionLayer = typeof RETENTION_LAYERS[number];
export type RetentionOutcome = 'issued' | 'review' | 'denied' | 'error';
export type RetentionTrigger = 'collected-at' | 'decision-at' | 'terminal-at';
export type CredentialDisposition = 'unchanged' | 'source-revoked' | 'not-issued';
export type RetentionAction = 'delete' | 'expire' | 'external-delete' | 'retain-minimized' | 'client-controlled' | 'irreversible';

export interface RetentionLayerRuleV1 {
  layer: RetentionLayer;
  action: RetentionAction;
  /** Defaults to the outcome trigger. Journal expiry uses terminal-at. */
  trigger?: RetentionTrigger;
  /** Null is only valid for effects Proofmark cannot delete: client copies and public-chain data. */
  durationDays: number | null;
  retentionRef: string;
}

export interface RetentionRuleV1 {
  outcome: RetentionOutcome;
  trigger: RetentionTrigger;
  credentialDisposition: CredentialDisposition;
  layers: readonly RetentionLayerRuleV1[];
}

export interface RetentionPolicyV1 {
  schema: typeof RETENTION_POLICY_SCHEMA;
  policyId: string;
  /** Opaque customer/deployment identifier, never a natural-person identifier. */
  customerId: string;
  jurisdiction: string;
  status: 'synthetic' | 'approved';
  approvalRef: string | null;
  legalReviewRef: string | null;
  clockRef: string;
  holdAuthorityRef: string;
  rules: readonly RetentionRuleV1[];
}

export interface RetentionPolicyBindingV1 {
  schema: 'proofmark-retention-policy-binding-v1';
  policyId: string;
  customerId: string;
  jurisdiction: string;
  fingerprint: string;
}

export interface RetentionPolicyEvidenceV1 extends Omit<RetentionPolicyBindingV1, 'schema'> {
  schema: 'proofmark-retention-policy-evidence-v1';
  outcome: RetentionOutcome;
  trigger: RetentionTrigger;
  triggerAt: number;
  vaultDeleteAt: number;
  credentialDisposition: CredentialDisposition;
  approvalRef: string | null;
  legalReviewRef: string | null;
  clockRef: string;
  holdAuthorityRef: string;
}

export interface DerivedRetentionLayer {
  layer: RetentionLayer;
  action: RetentionAction;
  trigger: RetentionTrigger;
  deleteAt: number | null;
  retentionRef: string;
}

export interface DerivedRetentionSchedule {
  schema: 'proofmark-retention-schedule-v1';
  policyId: string;
  customerId: string;
  jurisdiction: string;
  policyFingerprint: string;
  outcome: RetentionOutcome;
  trigger: RetentionTrigger;
  triggerAt: number;
  credentialDisposition: CredentialDisposition;
  layers: readonly DerivedRetentionLayer[];
}

export interface RetentionCompletionObservation {
  policyFingerprint: string;
  checkedAt: number;
  activeHolds: readonly string[];
  credential: {
    disposition: CredentialDisposition;
    sourceRevoked?: boolean;
    hubEnforced?: boolean;
    neverIssued?: boolean;
    maintained?: boolean;
  };
  layers: readonly {
    layer: RetentionLayer;
    status: 'deleted' | 'retained-minimized' | 'client-controlled' | 'irreversible-residual';
    evidenceRef: string;
  }[];
}

export class RetentionPolicyError extends Error {
  constructor(readonly code: 'RETENTION_POLICY_INVALID' | 'RETENTION_POLICY_CHANGED' | 'RETENTION_COMPLETION_INCOMPLETE', message: string) {
    super(message);
    this.name = 'RetentionPolicyError';
  }
}

const DAY_MS = 86_400_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/;
const JURISDICTION = /^(?:[A-Z]{2}|GLOBAL)$/;
const OUTCOMES = new Set<RetentionOutcome>(['issued', 'review', 'denied', 'error']);
const TRIGGERS = new Set<RetentionTrigger>(['collected-at', 'decision-at', 'terminal-at']);
const DISPOSITIONS = new Set<CredentialDisposition>(['unchanged', 'source-revoked', 'not-issued']);
const ACTIONS = new Set<RetentionAction>(['delete', 'expire', 'external-delete', 'retain-minimized', 'client-controlled', 'irreversible']);
const LAYERS = new Set<RetentionLayer>(RETENTION_LAYERS);

const identifier = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw new Error(`${field} must be an opaque identifier`);
  return value;
};
const reference = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !REFERENCE.test(value)) throw new Error(`${field} must be an opaque evidence reference`);
  return value;
};
const timestamp = (value: number, field: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a Unix-millisecond timestamp`);
  return value;
};

/**
 * Validates a complete customer/jurisdiction/outcome schedule. References make decisions
 * attributable, but do not establish that the legal conclusion or clock is authoritative.
 */
export function defineRetentionPolicy(input: RetentionPolicyV1): Readonly<RetentionPolicyV1> {
  try {
    if (!input || input.schema !== RETENTION_POLICY_SCHEMA) throw new Error('unsupported retention policy schema');
    const policyId = identifier(input.policyId, 'retention policyId');
    const customerId = identifier(input.customerId, 'retention customerId');
    if (typeof input.jurisdiction !== 'string' || !JURISDICTION.test(input.jurisdiction)) throw new Error('retention jurisdiction must be ISO alpha-2 or GLOBAL');
    if (input.status !== 'synthetic' && input.status !== 'approved') throw new Error('retention policy status must be synthetic or approved');
    const approvalRef = input.approvalRef === null ? null : reference(input.approvalRef, 'retention approvalRef');
    const legalReviewRef = input.legalReviewRef === null ? null : reference(input.legalReviewRef, 'retention legalReviewRef');
    if (input.status === 'approved' && (!approvalRef || !legalReviewRef)) throw new Error('approved retention policy requires approval and legal review references');
    if (input.status === 'synthetic' && (approvalRef || legalReviewRef)) throw new Error('synthetic retention policy cannot claim approval or legal review');
    const clockRef = reference(input.clockRef, 'retention clockRef');
    const holdAuthorityRef = reference(input.holdAuthorityRef, 'retention holdAuthorityRef');
    if (!Array.isArray(input.rules) || input.rules.length !== OUTCOMES.size) throw new Error('retention policy requires one rule for every outcome');
    const seenOutcomes = new Set<RetentionOutcome>();
    const rules = input.rules.map((rule, ruleIndex) => {
      if (!rule || !OUTCOMES.has(rule.outcome)) throw new Error(`rules[${ruleIndex}].outcome is unsupported`);
      if (seenOutcomes.has(rule.outcome)) throw new Error('retention policy contains a duplicate outcome');
      seenOutcomes.add(rule.outcome);
      if (!TRIGGERS.has(rule.trigger) || rule.trigger === 'terminal-at') throw new Error(`rules[${ruleIndex}].trigger is unsupported`);
      if (!DISPOSITIONS.has(rule.credentialDisposition)) throw new Error(`rules[${ruleIndex}].credentialDisposition is unsupported`);
      if (rule.outcome === 'issued' && rule.credentialDisposition === 'not-issued') throw new Error('issued records cannot use the not-issued disposition');
      if (rule.outcome !== 'issued' && rule.credentialDisposition === 'source-revoked') throw new Error('non-issued outcomes cannot claim source revocation');
      if (!Array.isArray(rule.layers) || rule.layers.length !== RETENTION_LAYERS.length) throw new Error('each outcome must cover every storage/effect layer');
      const seenLayers = new Set<RetentionLayer>();
      const layers = rule.layers.map((layer: RetentionLayerRuleV1, layerIndex: number) => {
        if (!layer || !LAYERS.has(layer.layer)) throw new Error(`rules[${ruleIndex}].layers[${layerIndex}] is unsupported`);
        if (seenLayers.has(layer.layer)) throw new Error('retention rule contains a duplicate layer');
        seenLayers.add(layer.layer);
        if (!ACTIONS.has(layer.action)) throw new Error(`retention action for ${layer.layer} is unsupported`);
        const layerTrigger = layer.trigger ?? rule.trigger;
        if (!TRIGGERS.has(layerTrigger)) throw new Error(`retention trigger for ${layer.layer} is unsupported`);
        const residual = layer.layer === 'client-copy' || layer.layer === 'onchain';
        if (residual !== (layer.durationDays === null)) throw new Error(`${layer.layer} has an invalid deadline shape`);
        if (layer.durationDays !== null && (!Number.isSafeInteger(layer.durationDays) || layer.durationDays < 0 || layer.durationDays > 36_500)) {
          throw new Error(`${layer.layer} durationDays must be a bounded non-negative integer`);
        }
        if (layer.layer === 'client-copy' && layer.action !== 'client-controlled') throw new Error('client copies must be identified as client-controlled');
        if (layer.layer === 'onchain' && layer.action !== 'irreversible') throw new Error('onchain effects must be identified as irreversible');
        if (layer.layer === 'vendor' && layer.action !== 'external-delete') throw new Error('vendor records require an external deletion action');
        if (layer.layer === 'evidence-vault' && layer.action !== 'delete') throw new Error('the evidence vault requires a deletion action');
        if (layer.layer === 'issuance-journal'
          && (layer.action !== 'expire' || layerTrigger !== 'terminal-at' || layer.durationDays !== 1)) {
          throw new Error('issuance journal currently supports only terminal-at plus one-day expiry');
        }
        return Object.freeze({ ...layer, trigger: layerTrigger, retentionRef: reference(layer.retentionRef, `retentionRef for ${layer.layer}`) });
      });
      return Object.freeze({ ...rule, layers: Object.freeze(layers) });
    });
    if (seenOutcomes.size !== OUTCOMES.size) throw new Error('retention policy omits an outcome');
    return Object.freeze({ ...input, policyId, customerId, approvalRef, legalReviewRef, clockRef, holdAuthorityRef,
      rules: Object.freeze(rules) });
  } catch (error) {
    if (error instanceof RetentionPolicyError) throw error;
    throw new RetentionPolicyError('RETENTION_POLICY_INVALID', error instanceof Error ? error.message : 'retention policy is invalid');
  }
}

export function retentionPolicyFingerprint(input: RetentionPolicyV1): string {
  return createHash('sha256').update(`proofmark-retention-policy-v1|${canonicalJson(defineRetentionPolicy(input))}`).digest('hex');
}

export function retentionPolicyBinding(input: RetentionPolicyV1): RetentionPolicyBindingV1 {
  const policy = defineRetentionPolicy(input);
  return { schema: 'proofmark-retention-policy-binding-v1', policyId: policy.policyId, customerId: policy.customerId,
    jurisdiction: policy.jurisdiction, fingerprint: retentionPolicyFingerprint(policy) };
}

export function deriveRetentionSchedule(input: RetentionPolicyV1, context: {
  customerId: string;
  jurisdiction: string;
  outcome: RetentionOutcome;
  collectedAt: number;
  decisionAt: number;
  terminalAt?: number;
}): DerivedRetentionSchedule {
  const policy = defineRetentionPolicy(input);
  timestamp(context.collectedAt, 'collectedAt');
  timestamp(context.decisionAt, 'decisionAt');
  if (context.terminalAt !== undefined) timestamp(context.terminalAt, 'terminalAt');
  if (context.decisionAt < context.collectedAt) throw new RetentionPolicyError('RETENTION_POLICY_INVALID', 'decisionAt precedes collection');
  if (context.customerId !== policy.customerId || context.jurisdiction !== policy.jurisdiction) {
    throw new RetentionPolicyError('RETENTION_POLICY_CHANGED', 'retention customer or jurisdiction does not match the approved policy');
  }
  const rule = policy.rules.find(candidate => candidate.outcome === context.outcome);
  if (!rule) throw new RetentionPolicyError('RETENTION_POLICY_INVALID', 'retention outcome is not covered');
  const triggerAt = rule.trigger === 'collected-at' ? context.collectedAt : context.decisionAt;
  const layers = rule.layers.map(layer => {
    const layerTrigger = layer.trigger ?? rule.trigger;
    const layerTriggerAt = layerTrigger === 'collected-at' ? context.collectedAt
      : layerTrigger === 'decision-at' ? context.decisionAt : context.terminalAt;
    const deleteAt = layer.durationDays === null || layerTriggerAt === undefined ? null : layerTriggerAt + layer.durationDays * DAY_MS;
    if (deleteAt !== null && !Number.isSafeInteger(deleteAt)) throw new RetentionPolicyError('RETENTION_POLICY_INVALID', 'retention deadline is out of range');
    return Object.freeze({ layer: layer.layer, action: layer.action, trigger: layerTrigger, deleteAt, retentionRef: layer.retentionRef });
  });
  return Object.freeze({ schema: 'proofmark-retention-schedule-v1', policyId: policy.policyId, customerId: policy.customerId,
    jurisdiction: policy.jurisdiction, policyFingerprint: retentionPolicyFingerprint(policy), outcome: context.outcome,
    trigger: rule.trigger, triggerAt, credentialDisposition: rule.credentialDisposition, layers: Object.freeze(layers) });
}

export function retentionPolicyEvidence(input: RetentionPolicyV1, context: Parameters<typeof deriveRetentionSchedule>[1]): RetentionPolicyEvidenceV1 {
  const policy = defineRetentionPolicy(input);
  const binding = retentionPolicyBinding(policy);
  const schedule = deriveRetentionSchedule(policy, context);
  const vault = schedule.layers.find(layer => layer.layer === 'evidence-vault');
  if (!vault || vault.deleteAt === null) throw new RetentionPolicyError('RETENTION_POLICY_INVALID', 'vault deletion deadline is missing');
  return { ...binding, schema: 'proofmark-retention-policy-evidence-v1', outcome: schedule.outcome, trigger: schedule.trigger,
    triggerAt: schedule.triggerAt, vaultDeleteAt: vault.deleteAt, credentialDisposition: schedule.credentialDisposition,
    approvalRef: policy.approvalRef, legalReviewRef: policy.legalReviewRef, clockRef: policy.clockRef,
    holdAuthorityRef: policy.holdAuthorityRef };
}

export function assertRetentionBinding(input: RetentionPolicyV1, binding: RetentionPolicyBindingV1): void {
  const expected = retentionPolicyBinding(input);
  if (!binding || binding.schema !== expected.schema || binding.policyId !== expected.policyId
    || binding.customerId !== expected.customerId || binding.jurisdiction !== expected.jurisdiction
    || binding.fingerprint !== expected.fingerprint) {
    throw new RetentionPolicyError('RETENTION_POLICY_CHANGED', 'retention policy changed after wallet consent; start a new flow');
  }
}

/**
 * Proves only that every named layer/effect has the policy-required local observation. Vendor
 * references and client-control statements remain externally sourced evidence, not facts created here.
 */
export function assertRetentionCompletion(schedule: DerivedRetentionSchedule, observation: RetentionCompletionObservation): void {
  const blockers: string[] = [];
  try { timestamp(observation.checkedAt, 'checkedAt'); } catch { blockers.push('INVALID_CLOCK'); }
  if (observation.policyFingerprint !== schedule.policyFingerprint) blockers.push('POLICY_CHANGED');
  if (!Array.isArray(observation.activeHolds) || observation.activeHolds.length) blockers.push('ACTIVE_HOLD');
  if (observation.credential?.disposition !== schedule.credentialDisposition) blockers.push('CREDENTIAL_DISPOSITION_CHANGED');
  if (schedule.credentialDisposition === 'source-revoked' && (!observation.credential.sourceRevoked || !observation.credential.hubEnforced)) {
    blockers.push('CREDENTIAL_REVOCATION_NOT_ENFORCED');
  }
  if (schedule.credentialDisposition === 'not-issued' && !observation.credential.neverIssued) blockers.push('CREDENTIAL_ISSUANCE_NOT_EXCLUDED');
  if (schedule.credentialDisposition === 'unchanged' && !observation.credential.maintained) blockers.push('CREDENTIAL_MAINTENANCE_NOT_CONFIRMED');
  const byLayer = new Map(observation.layers.map(layer => [layer.layer, layer]));
  if (byLayer.size !== observation.layers.length) blockers.push('DUPLICATE_LAYER_OBSERVATION');
  for (const layer of schedule.layers) {
    const actual = byLayer.get(layer.layer);
    if (layer.action !== 'client-controlled' && layer.action !== 'irreversible' && layer.deleteAt === null) {
      blockers.push(`${layer.layer}:TRIGGER_MISSING`); continue;
    }
    if (!actual || !REFERENCE.test(actual.evidenceRef)) { blockers.push(`${layer.layer}:EVIDENCE_MISSING`); continue; }
    if (layer.action === 'client-controlled') {
      if (actual.status !== 'client-controlled') blockers.push(`${layer.layer}:CONTROL_NOT_DISCLOSED`);
    } else if (layer.action === 'irreversible') {
      if (actual.status !== 'irreversible-residual') blockers.push(`${layer.layer}:RESIDUAL_NOT_DISCLOSED`);
    } else if (layer.deleteAt !== null && observation.checkedAt >= layer.deleteAt) {
      if (actual.status !== 'deleted') blockers.push(`${layer.layer}:DELETION_NOT_CONFIRMED`);
    } else if (layer.action === 'retain-minimized') {
      if (actual.status !== 'retained-minimized') blockers.push(`${layer.layer}:MINIMIZATION_NOT_CONFIRMED`);
    } else if (actual.status !== 'deleted') {
      blockers.push(`${layer.layer}:EARLY_DELETION_NOT_CONFIRMED`);
    }
  }
  for (const layer of byLayer.keys()) if (!LAYERS.has(layer)) blockers.push('UNKNOWN_LAYER_OBSERVATION');
  if (blockers.length) throw new RetentionPolicyError('RETENTION_COMPLETION_INCOMPLETE', `RETENTION_COMPLETION_INCOMPLETE:${[...new Set(blockers)].join(',')}`);
}

export function retentionConsentStatement(input: RetentionPolicyV1): string {
  const policy = defineRetentionPolicy(input);
  const ruleSummary = policy.rules.map(rule => {
    const vault = rule.layers.find(layer => layer.layer === 'evidence-vault');
    return `${rule.outcome}:${rule.trigger}+${vault?.durationDays ?? 'missing'}d/${rule.credentialDisposition}`;
  }).join(',');
  return `Proofmark retention policy ${policy.policyId}; customer ${policy.customerId}; jurisdiction ${policy.jurisdiction}; ${ruleSummary}; holds ${policy.holdAuthorityRef}; client copies remain client-controlled and public-chain data is irreversible.`;
}

const syntheticLayers = (vaultDays: number): RetentionLayerRuleV1[] => [
  { layer: 'evidence-vault', action: 'delete', durationDays: vaultDays, retentionRef: `retention:synthetic-vault:${vaultDays}d` },
  { layer: 'issuance-journal', action: 'expire', trigger: 'terminal-at', durationDays: 1, retentionRef: 'retention:synthetic-journal:1d' },
  { layer: 'revocation-outbox', action: 'retain-minimized', durationDays: 30, retentionRef: 'retention:synthetic-outbox:30d' },
  { layer: 'backup', action: 'expire', durationDays: vaultDays, retentionRef: `retention:synthetic-backup:${vaultDays}d` },
  { layer: 'vendor', action: 'external-delete', durationDays: 0, retentionRef: 'retention:synthetic-demo-vendor:0d' },
  { layer: 'operational-log', action: 'retain-minimized', durationDays: 7, retentionRef: 'retention:synthetic-log:7d' },
  { layer: 'client-copy', action: 'client-controlled', durationDays: null, retentionRef: 'retention:synthetic-client-control' },
  { layer: 'onchain', action: 'irreversible', durationDays: null, retentionRef: 'retention:synthetic-onchain' },
];

export const SYNTHETIC_RETENTION_POLICY = defineRetentionPolicy({
  schema: RETENTION_POLICY_SCHEMA,
  policyId: 'proofmark-synthetic-retention-v1', customerId: 'synthetic-demo-only', jurisdiction: 'KR', status: 'synthetic',
  approvalRef: null, legalReviewRef: null, clockRef: 'clock:synthetic-process-time', holdAuthorityRef: 'authority:synthetic-test-only',
  rules: [
    { outcome: 'issued', trigger: 'decision-at', credentialDisposition: 'unchanged', layers: syntheticLayers(30) },
    { outcome: 'review', trigger: 'decision-at', credentialDisposition: 'not-issued', layers: syntheticLayers(30) },
    { outcome: 'denied', trigger: 'decision-at', credentialDisposition: 'not-issued', layers: syntheticLayers(30) },
    { outcome: 'error', trigger: 'decision-at', credentialDisposition: 'not-issued', layers: syntheticLayers(7) },
  ],
});
