import { ethers } from 'ethers';

import { ATTRS_SCHEMA_VERSION, unpackAttrs, validCredentialAttrs } from './attrs.js';
import { canonicalJson } from './canonical.js';
import { discloseClaim, verifyDisclosure, type Claim } from './claims.js';
import { EvidenceChain, type EvidenceStep } from './evidence.js';
import { Methods } from './methods.js';
import type { VaultRecord } from './vault.js';

export type AuditEvidenceErrorCode =
  | 'AUDIT_GRANT_INVALID' | 'AUDIT_GRANT_UNAUTHENTICATED' | 'AUDIT_GRANT_EXPIRED'
  | 'AUDIT_SCOPE_MISMATCH' | 'RETAINED_EVIDENCE_INVALID' | 'VENDOR_RECEIPT_UNAUTHENTICATED'
  | 'VENDOR_RECEIPT_MISMATCH' | 'ONCHAIN_COMMITMENT_MISMATCH' | 'EXPORT_INTEGRITY_INVALID';

export class AuditEvidenceError extends Error {
  constructor(readonly code: AuditEvidenceErrorCode) { super(code); this.name = 'AuditEvidenceError'; }
}

export interface AuditSignature {
  algorithm: 'ES256K-EIP191';
  keyId: string;
  value: string;
}

export interface AuditGrantPayloadV1 {
  schema: 'proofmark-audit-grant-v1';
  grantId: string;
  auditorId: string;
  customerId: string;
  recordId: string;
  /** Exact minimum openings authorized for this export, not a wildcard or maximum. */
  claimKeys: string[];
  purposeRef: string;
  authorizationRef: string;
  issuedAt: number;
  expiresAt: number;
}
export interface SignedAuditGrantV1 { payload: AuditGrantPayloadV1; signature: AuditSignature }

export interface InstitutionReceiptPayloadV1 {
  schema: 'proofmark-institution-receipt-v1';
  axis: 'id-document' | 'bank-account';
  recordId: string;
  providerId: string;
  productId: string;
  environment: 'production' | 'sandbox' | 'demo';
  providerReference: string;
  resultCode: string;
  outcome: 'passed' | 'failed';
  checkedAt: number;
  /** Digest of the exact PII-free jurisdiction_adapter axis stored in the evidence chain. */
  axisEvidenceDigest: string;
}
export interface SignedInstitutionReceiptV1 { payload: InstitutionReceiptPayloadV1; signature: AuditSignature }

export interface OnchainCommitmentObservationV1 {
  schema: 'proofmark-onchain-commitment-observation-v1';
  observedAt: number;
  chainId: number;
  source: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  requestId: string;
  subject: string;
  issuer: string;
  attrs: string;
  claimsRoot: string;
  evidenceHash: string;
}

export interface AuditTrustConfig {
  /** Public addresses are configuration pins. An address supplied inside an export is never trusted. */
  authorizers: Record<string, string>;
  /** Key: providerId|productId|environment|keyId. */
  receiptSigners: Record<string, string>;
  exporters: Record<string, string>;
}

export interface AuditExportPayloadV1 {
  schema: 'proofmark-audit-export-v1';
  exportId: string;
  generatedAt: number;
  grant: SignedAuditGrantV1;
  linkage: {
    requestId: string;
    credentialId: string;
    subject: string;
    sourceChainId: number;
    sourceContract: string;
    sourceTransactionHash: string;
    sourceBlockNumber: number;
    sourceBlockHash: string;
    issuer: string;
    attrs: string;
    claimsRoot: string;
    evidenceHash: string;
    consentVersion: string;
    consentStatementHash: string;
  };
  versions: {
    evidenceChain: 'proofmark-evidence-chain-v1';
    claimCommitment: 'proofmark-claims-merkle-v1';
    attrsSchema: number;
    amlEngine: string;
    amlLists: Record<string, number>;
    evidenceHmacKeyId: string | null;
    processingPolicyId: string;
    processingPolicyFingerprint: string;
    identityPolicyId: string;
    retentionPolicyId: string;
    retentionPolicyFingerprint: string;
  };
  evidence: EvidenceStep[];
  disclosures: { claim: Claim; proof: string[] }[];
  institutionReceipts: SignedInstitutionReceiptV1[];
  onchainObservation: OnchainCommitmentObservationV1;
  limitations: {
    originalInstitutionResponseRetained: false;
    hmacKeyHolderCanReidentifyCandidates: true;
    transferResponsibility: 'customer-controlled-authorized-export';
    receiptMeaning: 'signature-and-linkage-verified-not-legal-conclusion';
  };
}

export interface AuditExportEnvelopeV1 { payload: AuditExportPayloadV1; integrity: AuditSignature }

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/;
const fail = (code: AuditEvidenceErrorCode): never => { throw new AuditEvidenceError(code); };
const sameHex = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const address = (value: unknown): value is string => typeof value === 'string' && ethers.isAddress(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value);

const domainDigest = (domain: string, payload: unknown): string => ethers.keccak256(
  ethers.toUtf8Bytes(`${domain}\0${canonicalJson(payload)}`),
);

export const auditGrantDigest = (payload: AuditGrantPayloadV1): string => domainDigest('proofmark-audit-grant-v1', payload);
export const institutionReceiptDigest = (payload: InstitutionReceiptPayloadV1): string => domainDigest('proofmark-institution-receipt-v1', payload);
export const institutionAxisDigest = (axisEvidence: unknown): string => domainDigest('proofmark-institution-axis-v1', axisEvidence);
export const auditExportDigest = (payload: AuditExportPayloadV1): string => domainDigest('proofmark-audit-export-v1', payload);

function verifySignature(digest: string, signature: AuditSignature, expected: string | undefined, code: AuditEvidenceErrorCode): void {
  if (!signature || signature.algorithm !== 'ES256K-EIP191' || !identifier(signature.keyId)
    || typeof signature.value !== 'string' || !expected || !address(expected)) fail(code);
  let recovered = '';
  try { recovered = ethers.verifyMessage(ethers.getBytes(digest), signature.value); }
  catch { fail(code); }
  if (!sameHex(recovered, expected)) fail(code);
}

function validateGrant(grant: SignedAuditGrantV1, trust: AuditTrustConfig, at: number): void {
  const p = grant?.payload;
  if (!p || p.schema !== 'proofmark-audit-grant-v1' || !identifier(p.grantId) || !identifier(p.auditorId)
    || !identifier(p.customerId) || !HEX32.test(p.recordId) || !identifier(p.purposeRef) || !identifier(p.authorizationRef)
    || !timestamp(p.issuedAt) || !timestamp(p.expiresAt) || p.expiresAt <= p.issuedAt
    || !Array.isArray(p.claimKeys) || p.claimKeys.some(key => !identifier(key))
    || new Set(p.claimKeys).size !== p.claimKeys.length || !timestamp(at)) fail('AUDIT_GRANT_INVALID');
  verifySignature(auditGrantDigest(p), grant.signature, trust.authorizers[grant.signature?.keyId], 'AUDIT_GRANT_UNAUTHENTICATED');
  if (at < p.issuedAt || at >= p.expiresAt) fail('AUDIT_GRANT_EXPIRED');
}

function receiptTrustKey(receipt: SignedInstitutionReceiptV1): string {
  const p = receipt.payload;
  return `${p.providerId}|${p.productId}|${p.environment}|${receipt.signature?.keyId ?? ''}`;
}

function validateReceiptSignature(receipt: SignedInstitutionReceiptV1, trust: AuditTrustConfig): void {
  const p = receipt?.payload;
  if (!p || p.schema !== 'proofmark-institution-receipt-v1' || !['id-document', 'bank-account'].includes(p.axis)
    || !HEX32.test(p.recordId) || !identifier(p.providerId) || !identifier(p.productId)
    || !['production', 'sandbox', 'demo'].includes(p.environment) || !identifier(p.providerReference)
    || !identifier(p.resultCode) || !['passed', 'failed'].includes(p.outcome) || !timestamp(p.checkedAt)
    || !HEX32.test(p.axisEvidenceDigest)) fail('VENDOR_RECEIPT_UNAUTHENTICATED');
  verifySignature(institutionReceiptDigest(p), receipt.signature, trust.receiptSigners[receiptTrustKey(receipt)], 'VENDOR_RECEIPT_UNAUTHENTICATED');
}

function evidenceSteps(value: unknown): EvidenceStep[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(step => !object(step) || !identifier(step.step)
    || !timestamp(step.at) || !object(step.payload))) fail('RETAINED_EVIDENCE_INVALID');
  return structuredClone(value) as EvidenceStep[];
}

function oneStep(steps: EvidenceStep[], name: string): EvidenceStep {
  const found = steps.filter(step => step.step === name);
  if (found.length !== 1) fail('RETAINED_EVIDENCE_INVALID');
  return found[0];
}

function claimList(value: unknown): Claim[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(claim => !object(claim)
    || !identifier(claim.key) || typeof claim.value !== 'string' || !HEX32.test(String(claim.salt)))) fail('RETAINED_EVIDENCE_INVALID');
  const claims = structuredClone(value) as Claim[];
  if (new Set(claims.map(claim => claim.key)).size !== claims.length) fail('RETAINED_EVIDENCE_INVALID');
  return claims;
}

function axisFromEvidence(steps: EvidenceStep[], axis: InstitutionReceiptPayloadV1['axis']): Record<string, unknown> {
  const adapter = oneStep(steps, 'jurisdiction_adapter').payload;
  const value = adapter[axis === 'id-document' ? 'idDocument' : 'bankAccount'];
  if (!object(value)) fail('VENDOR_RECEIPT_MISMATCH');
  return value as Record<string, unknown>;
}

function requiredReceiptAxes(attrs: string): InstitutionReceiptPayloadV1['axis'][] {
  let methods = 0;
  try { methods = unpackAttrs(attrs).methods; } catch { fail('RETAINED_EVIDENCE_INVALID'); }
  const axes: InstitutionReceiptPayloadV1['axis'][] = [];
  if ((methods & Methods.ID_DOC_AUTHENTICITY) !== 0) axes.push('id-document');
  if ((methods & Methods.BANK_ACCOUNT) !== 0) axes.push('bank-account');
  return axes;
}

function validateReceipts(receipts: SignedInstitutionReceiptV1[], steps: EvidenceStep[], attrs: string,
  recordId: string, trust: AuditTrustConfig, at: number): void {
  if (!Array.isArray(receipts)) fail('VENDOR_RECEIPT_UNAUTHENTICATED');
  const required = requiredReceiptAxes(attrs);
  const byAxis = new Map<string, SignedInstitutionReceiptV1>();
  for (const receipt of receipts) {
    validateReceiptSignature(receipt, trust);
    if (receipt.payload.checkedAt > at) fail('VENDOR_RECEIPT_MISMATCH');
    if (byAxis.has(receipt.payload.axis)) fail('VENDOR_RECEIPT_MISMATCH');
    byAxis.set(receipt.payload.axis, receipt);
  }
  if (receipts.length !== required.length || required.some(axis => !byAxis.has(axis))) fail('VENDOR_RECEIPT_UNAUTHENTICATED');
  for (const axisName of required) {
    const receipt = byAxis.get(axisName)!;
    const axis = axisFromEvidence(steps, axisName);
    const expectedLive = unpackAttrs(attrs).regime === 1;
    if (!sameHex(receipt.payload.recordId, recordId) || receipt.payload.outcome !== 'passed'
      || receipt.payload.providerId !== axis.vendor || receipt.payload.providerReference !== axis.ref
      || !sameHex(receipt.payload.axisEvidenceDigest, institutionAxisDigest(axis))
      || axis.live !== expectedLive || (expectedLive && receipt.payload.environment !== 'production')) fail('VENDOR_RECEIPT_MISMATCH');
    if (axisName === 'id-document' && (axis.authenticityChecked !== true || axis.authentic !== true
      || (axis.code !== null && axis.code !== undefined && receipt.payload.resultCode !== axis.code))) fail('VENDOR_RECEIPT_MISMATCH');
    if (axisName === 'bank-account' && (axis.holderVerified !== true || axis.oneWonVerified !== true)) fail('VENDOR_RECEIPT_MISMATCH');
  }
}

function validateOnchain(observation: OnchainCommitmentObservationV1, linkage: AuditExportPayloadV1['linkage']): void {
  if (!observation || observation.schema !== 'proofmark-onchain-commitment-observation-v1' || !timestamp(observation.observedAt)
    || !Number.isSafeInteger(observation.chainId) || observation.chainId <= 0 || !address(observation.source)
    || !HEX32.test(observation.transactionHash) || !Number.isSafeInteger(observation.blockNumber) || observation.blockNumber < 0
    || !HEX32.test(observation.blockHash) || !HEX32.test(observation.requestId) || !address(observation.subject)
    || !address(observation.issuer) || !HEX32.test(observation.attrs) || !HEX32.test(observation.claimsRoot)
    || !HEX32.test(observation.evidenceHash)) fail('ONCHAIN_COMMITMENT_MISMATCH');
  if (observation.chainId !== linkage.sourceChainId || !sameHex(observation.source, linkage.sourceContract)
    || !sameHex(observation.transactionHash, linkage.sourceTransactionHash) || observation.blockNumber !== linkage.sourceBlockNumber
    || !sameHex(observation.blockHash, linkage.sourceBlockHash) || !sameHex(observation.requestId, linkage.requestId)
    || !sameHex(observation.subject, linkage.subject) || !sameHex(observation.issuer, linkage.issuer)
    || !sameHex(observation.attrs, linkage.attrs) || !sameHex(observation.claimsRoot, linkage.claimsRoot)
    || !sameHex(observation.evidenceHash, linkage.evidenceHash)) fail('ONCHAIN_COMMITMENT_MISMATCH');
}

function versionsFrom(steps: EvidenceStep[]): AuditExportPayloadV1['versions'] {
  const processing = oneStep(steps, 'processing_policy').payload;
  const retention = oneStep(steps, 'retention_policy').payload;
  const aml = oneStep(steps, 'aml').payload;
  const identity = oneStep(steps, 'identity_policy').payload;
  const amlEvidence = object(aml.evidence) ? aml.evidence : {};
  if (processing.schema !== 'proofmark-processing-policy-evidence-v1' || !identifier(processing.policyId)
    || typeof processing.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(processing.fingerprint)
    || !HEX32.test(String(processing.consentStatementHash)) || !identifier(identity.policyId)
    || retention.schema !== 'proofmark-retention-policy-binding-v1' || !identifier(retention.policyId)
    || !identifier(retention.customerId) || retention.customerId !== processing.customerId
    || typeof retention.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(retention.fingerprint)
    || !identifier(aml.engineVersion) || !object(aml.listVersions)
    || Object.entries(aml.listVersions).some(([key, value]) => !identifier(key) || !Number.isSafeInteger(value) || (value as number) < 0)
    || (amlEvidence.keyId !== undefined && !identifier(amlEvidence.keyId))) fail('RETAINED_EVIDENCE_INVALID');
  return {
    evidenceChain: 'proofmark-evidence-chain-v1', claimCommitment: 'proofmark-claims-merkle-v1', attrsSchema: ATTRS_SCHEMA_VERSION,
    amlEngine: aml.engineVersion as string, amlLists: structuredClone(aml.listVersions) as Record<string, number>,
    evidenceHmacKeyId: typeof amlEvidence.keyId === 'string' ? amlEvidence.keyId : null,
    processingPolicyId: processing.policyId as string, processingPolicyFingerprint: processing.fingerprint as string,
    identityPolicyId: identity.policyId as string,
    retentionPolicyId: retention.policyId as string,
    retentionPolicyFingerprint: retention.fingerprint as string,
  };
}

function credentialId(linkage: Omit<AuditExportPayloadV1['linkage'], 'credentialId' | 'consentVersion' | 'consentStatementHash'
  | 'sourceBlockNumber' | 'sourceBlockHash' | 'sourceTransactionHash'>): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'address', 'bytes32', 'address', 'address', 'bytes32', 'bytes32', 'bytes32'],
    [linkage.sourceChainId, linkage.sourceContract, linkage.requestId, linkage.subject, linkage.issuer,
      linkage.attrs, linkage.claimsRoot, linkage.evidenceHash],
  ));
}

function validatePayload(payload: AuditExportPayloadV1, trust: AuditTrustConfig, at: number): void {
  if (!payload || payload.schema !== 'proofmark-audit-export-v1' || !HEX32.test(payload.exportId) || !timestamp(payload.generatedAt)
    || payload.generatedAt > at || !payload.linkage || !payload.versions || !payload.onchainObservation || !Array.isArray(payload.disclosures)
    || !Array.isArray(payload.institutionReceipts)) fail('RETAINED_EVIDENCE_INVALID');
  validateGrant(payload.grant, trust, at);
  const expectedExportId = domainDigest('proofmark-audit-export-id-v1', {
    grantId: payload.grant.payload.grantId, recordId: payload.linkage.requestId,
    generatedAt: payload.generatedAt, evidenceHash: payload.linkage.evidenceHash,
  });
  if (!sameHex(payload.exportId, expectedExportId) || payload.onchainObservation.observedAt > payload.generatedAt) {
    fail('ONCHAIN_COMMITMENT_MISMATCH');
  }
  if (!sameHex(payload.grant.payload.recordId, payload.linkage.requestId)
    || payload.grant.payload.claimKeys.length !== payload.disclosures.length
    || payload.grant.payload.claimKeys.some((key, index) => payload.disclosures[index]?.claim?.key !== key)) fail('AUDIT_SCOPE_MISMATCH');
  const steps = evidenceSteps(payload.evidence);
  if (!sameHex(EvidenceChain.recompute(steps), payload.linkage.evidenceHash) || !validCredentialAttrs(payload.linkage.attrs)) {
    fail('RETAINED_EVIDENCE_INVALID');
  }
  const commitment = oneStep(steps, 'commitment').payload, issue = oneStep(steps, 'issue').payload;
  if (!sameHex(commitment.claimsRoot, payload.linkage.claimsRoot) || !Number.isSafeInteger(commitment.claimCount)
    || !sameHex(issue.attrs, payload.linkage.attrs) || !sameHex(issue.claimsRoot, payload.linkage.claimsRoot)) fail('RETAINED_EVIDENCE_INVALID');
  for (const disclosure of payload.disclosures) {
    if (!disclosure || !object(disclosure.claim) || !Array.isArray(disclosure.proof)
      || disclosure.proof.some(item => typeof item !== 'string' || !HEX32.test(item))
      || !verifyDisclosure(payload.linkage.claimsRoot, disclosure.claim as Claim, disclosure.proof)) fail('RETAINED_EVIDENCE_INVALID');
  }
  const processing = oneStep(steps, 'processing_policy').payload;
  if (processing.customerId !== payload.grant.payload.customerId || processing.noticeVersion !== payload.linkage.consentVersion
    || !sameHex(processing.consentStatementHash, payload.linkage.consentStatementHash)) fail('AUDIT_SCOPE_MISMATCH');
  const expectedVersions = versionsFrom(steps);
  if (canonicalJson(expectedVersions) !== canonicalJson(payload.versions)) fail('RETAINED_EVIDENCE_INVALID');
  validateReceipts(payload.institutionReceipts, steps, payload.linkage.attrs, payload.linkage.requestId, trust, payload.generatedAt);
  validateOnchain(payload.onchainObservation, payload.linkage);
  const { credentialId: claimed, consentVersion: _consentVersion, consentStatementHash: _consentStatementHash,
    sourceBlockNumber: _sourceBlockNumber, sourceBlockHash: _sourceBlockHash, sourceTransactionHash: _sourceTransactionHash,
    ...credentialLinkage } = payload.linkage;
  if (!sameHex(claimed, credentialId(credentialLinkage))) fail('ONCHAIN_COMMITMENT_MISMATCH');
  if (canonicalJson(payload.limitations) !== canonicalJson({ originalInstitutionResponseRetained: false,
    hmacKeyHolderCanReidentifyCandidates: true, transferResponsibility: 'customer-controlled-authorized-export',
    receiptMeaning: 'signature-and-linkage-verified-not-legal-conclusion' })) fail('RETAINED_EVIDENCE_INVALID');
}

export function prepareAuditExport(input: {
  record: VaultRecord;
  grant: SignedAuditGrantV1;
  receipts: SignedInstitutionReceiptV1[];
  onchain: OnchainCommitmentObservationV1;
  trust: AuditTrustConfig;
  generatedAt?: number;
}): AuditExportPayloadV1 {
  const generatedAt = input.generatedAt ?? Date.now();
  validateGrant(input.grant, input.trust, generatedAt);
  const record = input.record;
  if (!record || !HEX32.test(record.id) || !address(record.walletAddress) || !HEX32.test(record.evidenceHash)
    || !record.attrs || !record.claimsRoot || !record.claims || !record.sourceIssuance || !record.retentionPolicy
    || !sameHex(record.id, input.grant.payload.recordId) || !timestamp(record.createdAt)
    || generatedAt < record.createdAt) fail('AUDIT_SCOPE_MISMATCH');
  const attrs = record.attrs as string;
  const retainedClaimsRoot = record.claimsRoot as string;
  const retainedSource = record.sourceIssuance as NonNullable<VaultRecord['sourceIssuance']>;
  const retainedRetention = record.retentionPolicy as NonNullable<VaultRecord['retentionPolicy']>;
  if (!attrs || !retainedClaimsRoot || !retainedSource) fail('AUDIT_SCOPE_MISMATCH');
  const steps = evidenceSteps(record.evidence);
  if (!sameHex(EvidenceChain.recompute(steps), record.evidenceHash)) fail('RETAINED_EVIDENCE_INVALID');
  const claims = claimList(record.claims);
  const commitment = oneStep(steps, 'commitment').payload, issue = oneStep(steps, 'issue').payload;
  if (!sameHex(commitment.claimsRoot, retainedClaimsRoot) || commitment.claimCount !== claims.length
    || !sameHex(issue.attrs, attrs) || !sameHex(issue.claimsRoot, retainedClaimsRoot)) fail('RETAINED_EVIDENCE_INVALID');
  const processing = oneStep(steps, 'processing_policy').payload;
  const retention = oneStep(steps, 'retention_policy').payload;
  if (processing.customerId !== input.grant.payload.customerId || processing.noticeVersion !== record.consentVersion
    || !HEX32.test(String(processing.consentStatementHash)) || retention.policyId !== retainedRetention.policyId
    || retention.fingerprint !== retainedRetention.fingerprint) fail('AUDIT_SCOPE_MISMATCH');
  if (input.grant.payload.claimKeys.some(key => !claims.some(claim => claim.key === key))) fail('AUDIT_SCOPE_MISMATCH');
  validateReceipts(input.receipts, steps, attrs, record.id, input.trust, generatedAt);
  const baseLinkage = {
    requestId: record.id, subject: ethers.getAddress(record.walletAddress), sourceChainId: retainedSource.chainId,
    sourceContract: ethers.getAddress(retainedSource.source), issuer: ethers.getAddress(input.onchain.issuer),
    attrs, claimsRoot: retainedClaimsRoot, evidenceHash: record.evidenceHash,
  };
  const linkage: AuditExportPayloadV1['linkage'] = {
    ...baseLinkage, credentialId: credentialId(baseLinkage), sourceTransactionHash: retainedSource.transactionHash,
    sourceBlockNumber: input.onchain.blockNumber, sourceBlockHash: input.onchain.blockHash,
    consentVersion: record.consentVersion, consentStatementHash: String(processing.consentStatementHash),
  };
  validateOnchain(input.onchain, linkage);
  const exportId = domainDigest('proofmark-audit-export-id-v1', {
    grantId: input.grant.payload.grantId, recordId: record.id, generatedAt, evidenceHash: record.evidenceHash,
  });
  const payload: AuditExportPayloadV1 = {
    schema: 'proofmark-audit-export-v1', exportId, generatedAt, grant: structuredClone(input.grant), linkage,
    versions: versionsFrom(steps), evidence: steps,
    disclosures: input.grant.payload.claimKeys.map(key => discloseClaim(claims, key)),
    institutionReceipts: structuredClone(input.receipts), onchainObservation: structuredClone(input.onchain),
    limitations: { originalInstitutionResponseRetained: false, hmacKeyHolderCanReidentifyCandidates: true,
      transferResponsibility: 'customer-controlled-authorized-export',
      receiptMeaning: 'signature-and-linkage-verified-not-legal-conclusion' },
  };
  validatePayload(payload, input.trust, generatedAt);
  return payload;
}

export function sealAuditExport(payload: AuditExportPayloadV1, keyId: string, signature: string): AuditExportEnvelopeV1 {
  if (!identifier(keyId) || typeof signature !== 'string') fail('EXPORT_INTEGRITY_INVALID');
  return { payload, integrity: { algorithm: 'ES256K-EIP191', keyId, value: signature } };
}

export function verifyAuditExport(envelope: AuditExportEnvelopeV1, trust: AuditTrustConfig,
  independentOnchain: OnchainCommitmentObservationV1, now = Date.now()): {
  valid: true; exportId: string; fingerprint: string; evidenceHash: string; claimsRoot: string;
  receiptCount: number; disclosureCount: number;
} {
  if (!envelope?.payload || !envelope.integrity) fail('EXPORT_INTEGRITY_INVALID');
  const digest = auditExportDigest(envelope.payload);
  verifySignature(digest, envelope.integrity, trust.exporters[envelope.integrity.keyId], 'EXPORT_INTEGRITY_INVALID');
  validatePayload(envelope.payload, trust, now);
  // The verifier must supply its own read-only observation; the exporter-supplied copy is not a
  // substitute for querying an independently selected source-chain endpoint.
  validateOnchain(independentOnchain, envelope.payload.linkage);
  if (canonicalJson(independentOnchain) !== canonicalJson(envelope.payload.onchainObservation)) {
    fail('ONCHAIN_COMMITMENT_MISMATCH');
  }
  return { valid: true, exportId: envelope.payload.exportId, fingerprint: digest,
    evidenceHash: envelope.payload.linkage.evidenceHash, claimsRoot: envelope.payload.linkage.claimsRoot,
    receiptCount: envelope.payload.institutionReceipts.length, disclosureCount: envelope.payload.disclosures.length };
}

/** Bounded operational event. Deliberately excludes wallet, claims, evidence, refs and signatures. */
export function auditExportObservation(result: ReturnType<typeof verifyAuditExport>) {
  return { schema: 'proofmark-audit-export-observation-v1' as const, event: 'audit-export-verified' as const,
    exportFingerprint: result.fingerprint, receiptCount: result.receiptCount, disclosureCount: result.disclosureCount };
}
