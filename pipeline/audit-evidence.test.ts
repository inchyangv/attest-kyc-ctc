import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import {
  AuditEvidenceError,
  auditExportDigest,
  auditExportObservation,
  auditGrantDigest,
  institutionAxisDigest,
  institutionReceiptDigest,
  prepareAuditExport,
  sealAuditExport,
  verifyAuditExport,
} from './audit-evidence.js';
import { packAttrs } from './attrs.js';
import { claimsRoot, type Claim } from './claims.js';
import { EvidenceChain, type EvidenceStep } from './evidence.js';
import { Methods } from './methods.js';
import type { VaultRecord } from './vault.js';

const NOW = 1_700_000_100_000;
const requestId = ethers.id('synthetic-t34-request');
const subject = ethers.getAddress(`0x${'ab'.repeat(20)}`);
const source = ethers.getAddress(`0x${'cd'.repeat(20)}`);
const issuer = ethers.getAddress(`0x${'ef'.repeat(20)}`);
const transactionHash = ethers.id('synthetic-source-transaction');

async function fixture() {
  const authorizer = ethers.Wallet.createRandom();
  const institution = ethers.Wallet.createRandom();
  const exporter = ethers.Wallet.createRandom();
  const claims: Claim[] = [
    { key: 'fullName', value: 'Synthetic Holder', salt: `0x${'11'.repeat(32)}` },
    { key: 'dateOfBirth', value: '1990-01-01', salt: `0x${'22'.repeat(32)}` },
    { key: 'accountHolder', value: 'Synthetic Holder', salt: `0x${'33'.repeat(32)}` },
  ];
  const root = claimsRoot(claims);
  const attrs = packAttrs({ kind: 1, assurance: 3, regime: 1, jurisdiction: 410,
    methods: Methods.WALLET_CONTROL | Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED,
    issuedAt: 1_700_000_000, expiry: 1_710_000_000, epoch: 0 });
  const idAxis = { docType: 'RRC', docHash: ethers.id('synthetic-document'), vendor: 'codef', live: true,
    ref: 'id-receipt-001', code: 'CF-00000', authenticityChecked: true, authentic: true,
    faceMatched: false, livenessPassed: false };
  const bankAxis = { bankCode: '004', vendor: 'openbanking', live: true, ref: 'bank-receipt-001',
    holderVerified: true, oneWonVerified: true };
  const steps: EvidenceStep[] = [
    { step: 'wallet_control', at: NOW - 1_000, payload: { wallet: subject.toLowerCase(), proven: true } },
    { step: 'processing_policy', at: NOW - 1_000, payload: {
      schema: 'proofmark-processing-policy-evidence-v1', policyId: 'customer-alpha-processing-v1',
      customerId: 'customer-alpha', operatingModel: 'institution-service', noticeVersion: 'notice-v1',
      approvalRef: 'approval:processing:v1', legalReviewRef: 'legal:processing:v1',
      fingerprint: 'a'.repeat(64), consentStatementHash: `0x${'44'.repeat(32)}`,
    } },
    { step: 'retention_policy', at: NOW - 1_000, payload: {
      schema: 'proofmark-retention-policy-binding-v1', policyId: 'customer-alpha-retention-v1',
      customerId: 'customer-alpha', jurisdiction: 'KR', fingerprint: 'b'.repeat(64),
    } },
    { step: 'jurisdiction_adapter', at: NOW - 1_000, payload: {
      regime: 1, configuredRegime: 1, regimeRule: 'kr-results-v2', vendorsConnected: true,
      sandboxBits: false, liveResultsComplete: true, idDocument: idAxis, bankAccount: bankAxis,
    } },
    { step: 'reconcile', at: NOW - 1_000, payload: { axes: {}, digests: {}, passed: true } },
    { step: 'aml', at: NOW - 1_000, payload: {
      decision: 'ALLOW', riskBand: 1, hitCount: 0, listVersions: { OFAC_SDN: 20260907 },
      engineVersion: 'aml-1.4.0', methodsApplied: Methods.SANCTIONS_SCREENED,
      evidence: { keyId: 'evidence-k1', engineVersion: 'aml-1.4.0' },
    } },
    { step: 'identity_policy', at: NOW - 1_000, payload: {
      schema: 'proofmark-identity-evaluation-v1', policyId: 'customer-alpha-identity-v1', passed: true,
      assurance: 3, assuranceScale: 'policy-local', requirements: [],
    } },
    { step: 'commitment', at: NOW - 1_000, payload: { claimsRoot: root, claimCount: claims.length } },
    { step: 'issue', at: NOW - 1_000, payload: { attrs, claimsRoot: root } },
  ];
  const evidenceHash = EvidenceChain.recompute(steps);
  const record: VaultRecord = {
    id: requestId, walletAddress: subject, consentVersion: 'notice-v1',
    screeningSubject: { fullName: 'Synthetic Holder', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR', walletAddress: subject },
    evidenceHash, evidence: steps, attrs, claimsRoot: root, claims, state: 'active', createdAt: NOW - 1_000,
    retentionUntil: NOW + 86_400_000, rescreens: [], reviews: [],
    retentionPolicy: {
      schema: 'proofmark-retention-policy-evidence-v1', policyId: 'customer-alpha-retention-v1',
      customerId: 'customer-alpha', jurisdiction: 'KR', fingerprint: 'b'.repeat(64), outcome: 'issued',
      trigger: 'decision-at', triggerAt: NOW - 1_000, vaultDeleteAt: NOW + 86_400_000,
      credentialDisposition: 'unchanged', approvalRef: 'approval:retention:v1', legalReviewRef: 'legal:retention:v1',
      clockRef: 'clock:retention:v1', holdAuthorityRef: 'authority:hold:v1',
    },
    sourceIssuance: { transactionHash, chainId: 11155111, source, observedAt: NOW - 500 },
  };
  const grantPayload = {
    schema: 'proofmark-audit-grant-v1' as const, grantId: 'audit-grant-001', auditorId: 'auditor-alpha',
    customerId: 'customer-alpha', recordId: requestId, claimKeys: ['dateOfBirth'],
    purposeRef: 'purpose:independent-audit:v1', authorizationRef: 'approval:audit:001',
    issuedAt: NOW - 10_000, expiresAt: NOW + 60_000,
  };
  const grant = { payload: grantPayload, signature: { algorithm: 'ES256K-EIP191' as const, keyId: 'customer-auth-k1',
    value: await authorizer.signMessage(ethers.getBytes(auditGrantDigest(grantPayload))) } };
  const receiptPayloads = [
    { schema: 'proofmark-institution-receipt-v1' as const, axis: 'id-document' as const,
      recordId: requestId, providerId: 'codef', productId: 'KR_PB_MW_035', environment: 'production' as const,
      providerReference: 'id-receipt-001', resultCode: 'CF-00000', outcome: 'passed' as const,
      checkedAt: NOW - 1_000, axisEvidenceDigest: institutionAxisDigest(idAxis) },
    { schema: 'proofmark-institution-receipt-v1' as const, axis: 'bank-account' as const,
      recordId: requestId, providerId: 'openbanking', productId: 'deposit-and-holder-v1', environment: 'production' as const,
      providerReference: 'bank-receipt-001', resultCode: 'A0000', outcome: 'passed' as const,
      checkedAt: NOW - 1_000, axisEvidenceDigest: institutionAxisDigest(bankAxis) },
  ];
  const receipts = await Promise.all(receiptPayloads.map(async payload => ({ payload,
    signature: { algorithm: 'ES256K-EIP191' as const, keyId: 'institution-k1',
      value: await institution.signMessage(ethers.getBytes(institutionReceiptDigest(payload))) } })));
  const onchain = {
    schema: 'proofmark-onchain-commitment-observation-v1' as const, observedAt: NOW, chainId: 11155111,
    source, transactionHash, blockNumber: 100, blockHash: ethers.id('synthetic-source-block'),
    requestId, subject, issuer, attrs, claimsRoot: root, evidenceHash,
  };
  const trust = {
    authorizers: { 'customer-auth-k1': authorizer.address },
    receiptSigners: {
      'codef|KR_PB_MW_035|production|institution-k1': institution.address,
      'openbanking|deposit-and-holder-v1|production|institution-k1': institution.address,
    },
    exporters: { 'exporter-k1': exporter.address },
  };
  return { record, grant, receipts, onchain, trust, exporter };
}

test('PM-T34-01: a recomputable evidence hash plus unsigned vendor references is not an independently auditable result', async () => {
  const f = await fixture();
  assert.equal(EvidenceChain.recompute(f.record.evidence as EvidenceStep[]), f.record.evidenceHash);
  assert.throws(() => prepareAuditExport({ record: f.record, grant: f.grant, receipts: [], onchain: f.onchain,
    trust: f.trust, generatedAt: NOW }),
  (error: unknown) => error instanceof AuditEvidenceError && error.code === 'VENDOR_RECEIPT_UNAUTHENTICATED');
});

test('authorized minimal export links receipts, versions, consent, request, credential and source transaction for independent recomputation', async () => {
  const f = await fixture();
  const payload = prepareAuditExport({ record: f.record, grant: f.grant, receipts: f.receipts,
    onchain: f.onchain, trust: f.trust, generatedAt: NOW });
  const signature = await f.exporter.signMessage(ethers.getBytes(auditExportDigest(payload)));
  const envelope = sealAuditExport(payload, 'exporter-k1', signature);
  const verified = verifyAuditExport(envelope, f.trust, f.onchain, NOW);
  assert.equal(verified.evidenceHash, f.record.evidenceHash);
  assert.equal(verified.claimsRoot, f.record.claimsRoot);
  assert.equal(verified.receiptCount, 2);
  assert.deepEqual(payload.disclosures.map(item => item.claim.key), ['dateOfBirth']);
  assert.equal(payload.versions.amlEngine, 'aml-1.4.0');
  assert.equal(payload.linkage.requestId, requestId);
  assert.equal(payload.linkage.sourceTransactionHash, transactionHash);
  assert.equal(payload.linkage.consentStatementHash, `0x${'44'.repeat(32)}`);
  assert.equal(JSON.stringify(payload).includes('accountHolder'), false);
  assert.equal(JSON.stringify(payload).includes('Synthetic Holder'), false);
  assert.deepEqual(payload.limitations, {
    originalInstitutionResponseRetained: false,
    hmacKeyHolderCanReidentifyCandidates: true,
    transferResponsibility: 'customer-controlled-authorized-export',
    receiptMeaning: 'signature-and-linkage-verified-not-legal-conclusion',
  });
  const log = JSON.stringify(auditExportObservation(verified));
  for (const privateValue of [subject, '1990-01-01', 'Synthetic Holder', 'id-receipt-001', f.grant.signature.value]) {
    assert.equal(log.includes(privateValue), false);
  }
});

test('grant scope and signed export integrity fail closed', async () => {
  const f = await fixture();
  const wrongGrant = structuredClone(f.grant);
  wrongGrant.payload.claimKeys = ['fullName'];
  assert.throws(() => prepareAuditExport({ record: f.record, grant: wrongGrant, receipts: f.receipts,
    onchain: f.onchain, trust: f.trust, generatedAt: NOW }), /AUDIT_GRANT_UNAUTHENTICATED/);

  const payload = prepareAuditExport({ record: f.record, grant: f.grant, receipts: f.receipts,
    onchain: f.onchain, trust: f.trust, generatedAt: NOW });
  const signature = await f.exporter.signMessage(ethers.getBytes(auditExportDigest(payload)));
  const envelope = sealAuditExport(payload, 'exporter-k1', signature);
  envelope.payload.linkage.evidenceHash = ethers.id('tampered');
  assert.throws(() => verifyAuditExport(envelope, f.trust, f.onchain, NOW), /EXPORT_INTEGRITY_INVALID/);
});

test('receipt signature and exact onchain commitment are independently checked', async () => {
  const f = await fixture();
  const badReceipt = structuredClone(f.receipts);
  badReceipt[0].payload.providerReference = 'forged-reference';
  assert.throws(() => prepareAuditExport({ record: f.record, grant: f.grant, receipts: badReceipt,
    onchain: f.onchain, trust: f.trust, generatedAt: NOW }), /VENDOR_RECEIPT_UNAUTHENTICATED/);
  assert.throws(() => prepareAuditExport({ record: f.record, grant: f.grant, receipts: f.receipts,
    onchain: { ...f.onchain, evidenceHash: ethers.id('different-evidence') }, trust: f.trust, generatedAt: NOW }),
  /ONCHAIN_COMMITMENT_MISMATCH/);

  const payload = prepareAuditExport({ record: f.record, grant: f.grant, receipts: f.receipts,
    onchain: f.onchain, trust: f.trust, generatedAt: NOW });
  const signature = await f.exporter.signMessage(ethers.getBytes(auditExportDigest(payload)));
  const envelope = sealAuditExport(payload, 'exporter-k1', signature);
  assert.throws(() => verifyAuditExport(envelope, f.trust,
    { ...f.onchain, blockHash: ethers.id('independent-reader-saw-another-block') }, NOW),
  /ONCHAIN_COMMITMENT_MISMATCH/);
});
