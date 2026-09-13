import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import type { IssuanceEntry } from '../../pipeline/issuance-journal';
import { SYNTHETIC_PROCESSING_POLICY, policyBinding, processingConsentStatement } from '../../pipeline/privacy-processing-policy';
import { SYNTHETIC_RETENTION_POLICY, retentionPolicyBinding } from '../../pipeline/retention-policy';

for (const name of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_|ISSUANCE_JOURNAL_|ISSUER_PRIVATE_KEY|ISSUER_KEY_EPOCH|ROTATING_ISSUER_ADDRESS|EVIDENCE_VAULT_)/.test(name)) delete process.env[name];
process.env.KYC_DEMO = '1';
process.env.EVIDENCE_HMAC_KEY = 'synthetic-issuance-route-key-at-least-32-characters';
process.env.SERVER_TOKEN_KEY = 'synthetic-issuance-server-token-key-at-least-32-characters';
process.env.SERVER_TOKEN_KEY_ID = 'issuance-token-k1';
process.env.ISSUANCE_JOURNAL_REDIS_REST_URL = 'https://synthetic-journal.test';
process.env.ISSUANCE_JOURNAL_REDIS_REST_TOKEN = 'synthetic-token';
process.env.ISSUANCE_JOURNAL_KEY = 'synthetic-journal-encryption-key-32-characters';
const payloads = new Map<string, string>();
let mutations = 0;
// Read-only handler contract tests: Redis atomicity and mutation faults have real-Redis tests.
globalThis.fetch = async (_url, init) => {
  const args = JSON.parse(String(init?.body)); const n = Number(args[2]); const op = args[3 + n]; const key = args[3];
  if (op === 'create') { mutations++; if (!payloads.has(key)) payloads.set(key, args[3 + n + 4]); }
  else if (op !== 'get') throw new Error('read-only status attempted a mutation');
  return Response.json({ result: payloads.has(key) ? ['ok', '1', payloads.get(key)] : ['NOT_FOUND'] });
};
const { POST } = await import('../app/api/kyc/issue/route');
const { POST: statusPOST } = await import('../app/api/kyc/status/route');
const { issuanceJournal } = await import('../lib/issuance-server');
const { seal, CONSENT_VERSION, SIWE_STATEMENT, siweMessage } = await import('../lib/kyc-server');
const processingPolicy = policyBinding(SYNTHETIC_PROCESSING_POLICY);
const retentionPolicy = retentionPolicyBinding(SYNTHETIC_RETENTION_POLICY);
const flow = (address: string) => seal('wallet', { address, flowId: randomUUID(), consentVersion: CONSENT_VERSION, processingPolicy,
  retentionPolicy, consentStatementHash: `0x${'11'.repeat(32)}`, at: Date.now() }, 1800);
const entry = (): IssuanceEntry => ({ version: 1, requestId: ethers.id(randomUUID()), wallet: ethers.Wallet.createRandom().address,
  fingerprint: ethers.id('input'), consentVersion: CONSENT_VERSION, processingPolicy: undefined, retentionPolicy,
  createdAt: Date.now(), prepareUntil: Date.now() + 900000,
  phase: 'prepared', target: { chainId: 11155111, hubChainId: 102031, source: '0x' + '11'.repeat(20), issuer: '0x' + '22'.repeat(20), asc: '0x' + '33'.repeat(20) },
  outcome: { status: 'ISSUED', attrs: ethers.ZeroHash, claimsRoot: ethers.id('original-salted-claims'), evidenceHash: ethers.id('original-evidence'),
    claims: [{ key: 'fullName', value: 'Synthetic Person', salt: ethers.id('original-salt') }], evidence: [], methods: 4132, methodNames: [], expiry: 1800000000, regime: 2 },
  assurance: 3, evidenceStored: true, revertedTransactions: [] });
async function post(payload: object) {
  const response = await POST(new Request('http://localhost/api/kyc/issue', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-forwarded-for': randomUUID() }, body: JSON.stringify(payload) }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

async function postStatus(payload: object) {
  const response = await statusPOST(new Request('http://localhost/api/kyc/status', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', 'x-forwarded-for': randomUUID() }, body: JSON.stringify(payload) }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('fresh same-wallet proof recovers the original result without old ID/bank tokens or writes', async () => {
  const original = entry(); await issuanceJournal().create(original); const before = mutations;
  const response = await post({ action: 'status', requestId: original.requestId, walletProof: flow(original.wallet) });
  assert.equal(response.status, 200); assert.equal(response.body.status, 'PREPARED');
  assert.equal(response.body.issuance.phase, 'prepared'); assert.equal(response.body.onchain.sent, false);
  assert.equal(response.body.evidenceHash, original.outcome.evidenceHash);
  assert.deepEqual(response.body.claims, original.outcome.status === 'ISSUED' ? original.outcome.claims : []);
  assert.equal(mutations, before); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.passesKrProduction, undefined); assert.match(response.body.policyPreview.scope, /not an on-chain verdict/);
  for (let i = 0; i < 50; i++) {
    const polled = await post({ action: 'status', requestId: original.requestId, walletProof: flow(original.wallet) });
    assert.equal(polled.status, 200);
  }
  assert.equal(mutations, before, 'repeated status polling must not reserve gas or mutate the issuance journal');
});

test('foreign wallet cannot retrieve journal claims; missing proof and old consent are rejected', async () => {
  const original = entry(); await issuanceJournal().create(original);
  assert.equal((await post({ action: 'status', requestId: original.requestId, walletProof: flow(ethers.Wallet.createRandom().address) })).status, 404);
  assert.equal((await post({ action: 'status', requestId: original.requestId })).status, 400);
  const legacy = seal('wallet', { address: original.wallet, flowId: randomUUID(), consentVersion: 'proofmark-kyc-v2', at: Date.now() }, 1800);
  assert.equal((await post({ action: 'status', requestId: original.requestId, walletProof: legacy })).status, 400);
});

test('confirmed result hides signed bytes and is source success, not a blanket eligibility pass', async () => {
  const original = entry(); original.phase = 'source-confirmed';
  original.transaction = { hash: ethers.id('source-tx'), raw: 'signed-bytes-never-in-response', nonce: 0, chainId: original.target.chainId, source: original.target.source, issuer: original.target.issuer };
  original.sourceConfirmation = { blockNumber: 100, blockHash: ethers.id('block'), transactionIndex: 0, confirmedAt: Date.now() };
  await issuanceJournal().create(original);
  const response = await post({ action: 'status', requestId: original.requestId, walletProof: flow(original.wallet) });
  assert.equal(response.body.status, 'ISSUED'); assert.equal(response.body.issuance.phase, 'source-confirmed');
  assert.equal(response.body.onchain.sent, true); assert.equal(JSON.stringify(response.body).includes(original.transaction.raw), false);
  assert.equal(response.body.issuance.materializedAt, undefined);
});

test('PM-T24-01 source confirmation is not reported as CC3 or asset readiness by request status', async () => {
  const original = entry(); original.phase = 'source-confirmed';
  original.transaction = { hash: ethers.id('t24-source-tx'), raw: 'signed-bytes-never-in-response', nonce: 0, chainId: original.target.chainId, source: original.target.source, issuer: original.target.issuer };
  original.sourceConfirmation = { blockNumber: 101, blockHash: ethers.id('t24-source-block'), transactionIndex: 0, confirmedAt: Date.now() };
  await issuanceJournal().create(original); const before = mutations;
  const response = await postStatus({ action: 'resume', requestId: original.requestId, walletProof: flow(original.wallet) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.progress.source, { state: 'confirmed', blockNumber: 101, confirmedAt: original.sourceConfirmation.confirmedAt });
  assert.equal(response.body.progress.attestation.state, 'waiting');
  assert.equal(response.body.progress.policy.state, 'waiting-attestation');
  assert.equal(response.body.assetAction.ready, false);
  assert.equal(response.body.progress.nextAction, 'resume');
  assert.equal(mutations, before, 'the status endpoint must force a read-only lookup even if the body asks to resume');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('missing journal cannot start an unjournaled issuance; displayed consent is the SIWE statement', async () => {
  const url = process.env.ISSUANCE_JOURNAL_REDIS_REST_URL;
  delete process.env.ISSUANCE_JOURNAL_REDIS_REST_URL;
  try {
    const response = await post({ walletProof: flow(ethers.Wallet.createRandom().address), declared: {} });
    assert.equal(response.status, 503); assert.match(response.body.requestId, /^0x[0-9a-f]{64}$/);
  } finally { process.env.ISSUANCE_JOURNAL_REDIS_REST_URL = url; }
  assert.match(SIWE_STATEMENT, /proofmark-kyc-v4-synthetic/);
  assert.equal(SIWE_STATEMENT, processingConsentStatement(SYNTHETIC_PROCESSING_POLICY));
  assert.ok(siweMessage({ domain: 'localhost', address: ethers.Wallet.createRandom().address, uri: 'http://localhost/verify', nonce: '0123456789abcdef',
    issuedAt: new Date().toISOString(), expirationTime: new Date(Date.now() + 600000).toISOString() }).includes(SIWE_STATEMENT));
});
