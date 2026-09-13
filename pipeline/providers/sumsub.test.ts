import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InMemorySumsubStateStore, type SumsubSessionRecord } from './sumsub-state.js';
import { SumsubClient, SumsubError, applySumsubWebhookFence, retainSumsubWebhookFence, type SumsubConfig } from './sumsub.js';
import { SUMSUB_SANDBOX_TEST_IDENTITY_POLICY, SUMSUB_SANDBOX_TEST_RETENTION_POLICY,
  sumsubSandboxTestProcessingPolicy } from './sumsub-sandbox-policy.js';
import { authorizeProcessing, policyBinding } from '../privacy-processing-policy.js';
import { assertRetentionBinding, retentionPolicyBinding } from '../retention-policy.js';

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const WALLET = '0x1111111111111111111111111111111111111111';
const FLOW = '0123456789abcdef01234567';
const POLICY = '11'.repeat(32);
const RETENTION = '22'.repeat(32);
const APP_TOKEN = 'sandbox-app-token';
const SECRET = 'sandbox-api-secret';
const WEBHOOK = 'sandbox-webhook-secret';
const EVIDENCE = 'sumsub-evidence-key-that-is-at-least-thirty-two-chars';
const APPLICANT = '69e5d579e37291e569b75ce5';
const INSPECTION = '69e5d579e37291e569b75ce6';

type FixtureState = {
  status: Record<string, unknown>;
  applicantPatch?: Record<string, unknown>;
  hangStatus?: boolean;
  requests: { method: string; path: string; body: string; headers: IncomingMessage['headers'] }[];
};

async function fixture(state: FixtureState) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8'); const path = req.url ?? '';
    state.requests.push({ method: req.method ?? '', path, body, headers: req.headers });
    const ts = req.headers['x-app-access-ts']; const signature = req.headers['x-app-access-sig'];
    const expected = createHmac('sha256', SECRET).update(`${ts}${req.method}${path}${body}`).digest('hex');
    if (req.headers['x-app-token'] !== APP_TOKEN || signature !== expected) { res.writeHead(401).end('{}'); return; }
    if (path === '/resources/accessTokens/sdk') {
      const input = JSON.parse(body) as { userId: string };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ token: '_act-local-fixture', userId: input.userId })); return;
    }
    if (path.startsWith('/resources/applicants/-;externalUserId=') && path.endsWith('/one')) {
      const externalUserId = decodeURIComponent(path.slice('/resources/applicants/-;externalUserId='.length, -'/one'.length));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: APPLICANT, inspectionId: INSPECTION, externalUserId,
        type: 'individual', review: { levelName: 'proofmark-id-liveness' }, info: { country: 'KOR' }, ...state.applicantPatch })); return;
    }
    if (path === `/resources/applicants/${APPLICANT}/status`) {
      res.setHeader('content-type', 'application/json'); res.writeHead(200);
      if (state.hangStatus) { res.write('{'); return; }
      res.end(JSON.stringify(state.status)); return;
    }
    res.writeHead(404).end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { server.closeAllConnections(); server.close(); await once(server, 'close'); } };
}

const config = (url: string, patch: Partial<SumsubConfig> = {}): SumsubConfig => ({
  environment: 'sandbox', appToken: APP_TOKEN, secretKey: SECRET, webhookSecret: WEBHOOK,
  levelName: 'proofmark-id-liveness', processingRecipient: 'sumsub:eu', apiBaseUrl: url, localFixture: true,
  sdkTokenTtlSeconds: 600, requestTimeoutMs: 300, maxWebhookAgeMs: 10 * 60_000, evidenceHmacKey: EVIDENCE, ...patch,
});

function binding(client: SumsubClient) {
  return { walletAddress: WALLET, flowId: FLOW, externalUserId: client.makeExternalUserId(WALLET, FLOW),
    processingPolicyFingerprint: POLICY, retentionPolicyFingerprint: RETENTION };
}

function signWebhook(client: SumsubClient, patch: Record<string, unknown> = {}) {
  const value = { applicantId: APPLICANT, inspectionId: INSPECTION, applicantType: 'individual',
    externalUserId: binding(client).externalUserId, levelName: 'proofmark-id-liveness', type: 'applicantReviewed', sandboxMode: true,
    reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, createdAtMs: '2027-01-15 11:59:59.000', ...patch };
  const raw = Buffer.from(JSON.stringify(value));
  const digest = createHmac('sha256', WEBHOOK).update(raw).digest('hex');
  return { raw, headers: new Headers({ 'x-payload-digest-alg': 'HMAC_SHA256_HEX', 'x-payload-digest': digest }) };
}

test('sandbox test policies authorize only the hosted test boundary without claiming production approval', () => {
  const processing = sumsubSandboxTestProcessingPolicy('sumsub:sandbox');
  assert.equal(SUMSUB_SANDBOX_TEST_IDENTITY_POLICY.status, 'synthetic');
  assert.equal(SUMSUB_SANDBOX_TEST_IDENTITY_POLICY.approvalRef, null);
  assert.equal(processing.status, 'synthetic');
  assert.equal(processing.approvalRef, null);
  assert.equal(processing.onchain.approved, false);
  assert.equal(SUMSUB_SANDBOX_TEST_RETENTION_POLICY.status, 'synthetic');
  assert.equal(SUMSUB_SANDBOX_TEST_RETENTION_POLICY.approvalRef, null);
  authorizeProcessing(processing, policyBinding(processing), { stage: 'id_document', recipient: 'sumsub:sandbox',
    data: ['identity_document_image', 'identity_fields', 'biometric_template', 'screening_result', 'credential_metadata'] });
  assertRetentionBinding(SUMSUB_SANDBOX_TEST_RETENTION_POLICY, retentionPolicyBinding(SUMSUB_SANDBOX_TEST_RETENTION_POLICY));
  assert.throws(() => authorizeProcessing(processing, policyBinding(processing), { stage: 'issuance_processing',
    recipient: 'proofmark:issuer', data: ['credential_metadata'] }), /not present/);
});

test('signed REST requests bind one opaque external user and return a non-issuable current candidate', async () => {
  const state: FixtureState = { requests: [], status: { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, reviewDate: '2027-01-15 11:59:00+0000' } };
  const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url), fetch, () => NOW); const subject = binding(client);
    const token = await client.createSdkToken(subject.externalUserId);
    assert.deepEqual(token, { token: '_act-local-fixture', userId: subject.externalUserId, expiresIn: 600 });
    assert.match(subject.externalUserId, /^pm-sbx-[A-Za-z0-9_-]{43}$/);
    assert.equal(subject.externalUserId.includes(WALLET.slice(2)), false);
    const result = await client.evaluate(subject);
    assert.equal(result.decision, 'approved', 'fresh provider approval is represented without becoming issuance');
    assert.equal(result.methods, 0, 'overall GREEN does not prove per-step method bits');
    assert.equal(result.jurisdiction, null, 'applicant profile country is not document-derived jurisdiction evidence');
    assert.equal(result.methodMapping, 'pending-step-evidence');
    assert.equal(state.requests.length, 3);
    assert.equal(state.requests[1].path, `/resources/applicants/-;externalUserId=${encodeURIComponent(subject.externalUserId)}/one`);
    assert.equal(state.requests.every(request => typeof request.headers['x-app-access-sig'] === 'string'), true);
  } finally { await http.close(); }
});

test('exact wallet/flow/applicant/level binding fails closed', async () => {
  const state: FixtureState = { requests: [], status: { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } } };
  const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url), fetch, () => NOW); const subject = binding(client);
    await assert.rejects(client.evaluate({ ...subject, walletAddress: '0x2222222222222222222222222222222222222222' }), /SUMSUB_SUBJECT_MISMATCH/);
    await assert.rejects(client.evaluate({ ...subject, flowId: 'another-wallet-session' }), /SUMSUB_SUBJECT_MISMATCH/);
    state.applicantPatch = { externalUserId: 'pm-sbx-attacker', review: { levelName: 'different-level' } };
    await assert.rejects(client.evaluate(subject), /SUMSUB_APPLICANT_MISMATCH/);
  } finally { await http.close(); }
});

test('current status invalidates an earlier approval during ongoing review and final rejection', async () => {
  const state: FixtureState = { requests: [], status: { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, reviewDate: '2027-01-15 11:58:00+0000' } };
  const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url), fetch, () => NOW); const subject = binding(client);
    assert.equal((await client.evaluate(subject)).decision, 'approved');
    state.status = { reviewStatus: 'pending' };
    assert.equal((await client.evaluate(subject)).decision, 'review');
    state.status = { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' }, reviewDate: '2027-01-15 12:00:00+0000' };
    assert.equal((await client.evaluate(subject)).decision, 'rejected');
  } finally { await http.close(); }
});

test('raw webhook HMAC, UTC age, sandbox, replay and stale ordering are strict', async () => {
  const state: FixtureState = { requests: [], status: { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' } } };
  const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url), fetch, () => NOW); const signed = signWebhook(client);
    const webhook = client.verifyWebhook(signed.raw, signed.headers);
    assert.equal(webhook.sandboxMode, true); assert.equal(webhook.testMode, false); assert.equal(webhook.createdAtMs, NOW - 1_000);
    const store = new InMemorySumsubStateStore(); const subject = binding(client);
    const record: SumsubSessionRecord = { version: 1, revision: 1, externalUserId: subject.externalUserId, environment: 'sandbox',
      walletAddress: WALLET, flowId: FLOW, levelName: client.levelName, identityPolicyId: 'approved-identity-v1',
      processingPolicyFingerprint: POLICY, retentionPolicyFingerprint: RETENTION, createdAt: NOW - 5_000, expiresAt: NOW + 60_000 };
    await store.create(record);
    const observed = await client.evaluate(subject);
    assert.equal(await store.applyWebhook(subject.externalUserId, webhook.digest, webhook.createdAtMs, observed.applicantIdHash, observed), 'fresh');
    assert.equal(await store.applyWebhook(subject.externalUserId, webhook.digest, webhook.createdAtMs, observed.applicantIdHash, observed), 'duplicate');
    assert.equal(await store.applyWebhook(subject.externalUserId, 'a'.repeat(64), webhook.createdAtMs - 1, observed.applicantIdHash, observed), 'stale');

    const wrongEnvironment = signWebhook(client, { sandboxMode: false });
    assert.throws(() => client.verifyWebhook(wrongEnvironment.raw, wrongEnvironment.headers), /SUMSUB_WEBHOOK_INVALID/);
    const stale = signWebhook(client, { createdAtMs: '2027-01-15 11:40:00.000' });
    assert.throws(() => client.verifyWebhook(stale.raw, stale.headers), /SUMSUB_WEBHOOK_STALE/);
    const tampered = new Uint8Array(signed.raw); tampered[tampered.length - 2] ^= 1;
    assert.throws(() => client.verifyWebhook(tampered, signed.headers), /SUMSUB_WEBHOOK_SIGNATURE_INVALID/);
    const dashboardTest = signWebhook(client, { testMode: true });
    assert.equal(client.verifyWebhook(dashboardTest.raw, dashboardTest.headers).testMode, true);
    const invalidFalseTestMode = signWebhook(client, { testMode: false });
    assert.throws(() => client.verifyWebhook(invalidFalseTestMode.raw, invalidFalseTestMode.headers), /SUMSUB_WEBHOOK_INVALID/);
  } finally { await http.close(); }
});

test('signed ongoing-AML/rejection callbacks can downgrade but never grant approval', async () => {
  const state: FixtureState = { requests: [], status: { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, reviewDate: '2027-01-15 11:58:00+0000' } };
  const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url), fetch, () => NOW); const approved = await client.evaluate(binding(client));
    const ongoingSigned = signWebhook(client, { type: 'applicantPending', reviewStatus: 'pending', reviewMode: 'ongoingAml' });
    const ongoing = client.verifyWebhook(ongoingSigned.raw, ongoingSigned.headers);
    const fenced = applySumsubWebhookFence(approved, ongoing);
    assert.equal(fenced.decision, 'review'); assert.equal(fenced.webhookFence?.reason, 'ONGOING_REVIEW');
    assert.equal(retainSumsubWebhookFence(await client.evaluate(binding(client)), fenced).decision, 'review', 'older REST GREEN cannot clear webhook fence');
    state.status = { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, reviewDate: '2027-01-15 12:00:01+0000' };
    assert.equal(retainSumsubWebhookFence(await client.evaluate(binding(client)), fenced).decision, 'approved', 'newer authenticated review can clear fence');
    const greenCallback = client.verifyWebhook(signWebhook(client, { reviewResult: { reviewAnswer: 'GREEN' } }).raw,
      signWebhook(client, { reviewResult: { reviewAnswer: 'GREEN' } }).headers);
    assert.equal(applySumsubWebhookFence({ ...approved, decision: 'review' }, greenCallback).decision, 'review', 'callback GREEN never upgrades');
    const rejected = client.verifyWebhook(...(() => { const s = signWebhook(client, { reviewResult: { reviewAnswer: 'RED', reviewRejectType: 'FINAL' } }); return [s.raw, s.headers] as const; })());
    assert.equal(applySumsubWebhookFence(approved, rejected).decision, 'rejected');
  } finally { await http.close(); }
});

test('atomic callback apply survives a failing ordinary save and stale polling cannot clear its fence', async () => {
  const state: FixtureState = { requests: [], status: { reviewStatus: 'completed', reviewResult: { reviewAnswer: 'GREEN' }, reviewDate: '2027-01-15 11:58:00+0000' } };
  const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url), fetch, () => NOW); const subject = binding(client);
    const approved = await client.evaluate(subject);
    class CrashingOrdinarySaveStore extends InMemorySumsubStateStore {
      override async saveObservation(_externalUserId: string, _evidence: typeof approved, _expectedRevision: number): Promise<typeof approved> {
        throw new Error('simulated crash before ordinary save');
      }
    }
    const store = new CrashingOrdinarySaveStore();
    await store.create({ version: 1, revision: 1, externalUserId: subject.externalUserId, environment: 'sandbox', walletAddress: WALLET,
      flowId: FLOW, levelName: client.levelName, identityPolicyId: 'approved-identity-v1', processingPolicyFingerprint: POLICY,
      retentionPolicyFingerprint: RETENTION, createdAt: NOW - 5_000, expiresAt: NOW + 60_000 });
    const signed = signWebhook(client, { type: 'applicantPending', reviewStatus: 'pending', reviewMode: 'ongoingAml' });
    const webhook = client.verifyWebhook(signed.raw, signed.headers);
    const fenced = applySumsubWebhookFence(approved, webhook);
    assert.equal(await store.applyWebhook(subject.externalUserId, webhook.digest, webhook.createdAtMs,
      fenced.applicantIdHash, fenced), 'fresh');
    assert.equal((await store.get(subject.externalUserId))?.latest?.decision, 'review', 'claim and fence commit together');
    await assert.rejects(store.saveObservation(subject.externalUserId, approved, 2), /simulated crash/);
    assert.equal((await store.get(subject.externalUserId))?.latest?.decision, 'review', 'failed stale save cannot erase committed fence');
    const concurrent = new InMemorySumsubStateStore();
    await concurrent.create({ version: 1, revision: 1, externalUserId: subject.externalUserId, environment: 'sandbox', walletAddress: WALLET,
      flowId: FLOW, levelName: client.levelName, identityPolicyId: 'approved-identity-v1', processingPolicyFingerprint: POLICY,
      retentionPolicyFingerprint: RETENTION, createdAt: NOW - 5_000, expiresAt: NOW + 60_000 });
    await concurrent.applyWebhook(subject.externalUserId, webhook.digest, webhook.createdAtMs, fenced.applicantIdHash, fenced);
    await concurrent.saveObservation(subject.externalUserId, approved, 2);
    assert.equal((await concurrent.get(subject.externalUserId))?.latest?.decision, 'review', 'late old GREEN is monotonically merged');
  } finally { await http.close(); }
});

test('production cannot use loopback and a hanging response is bounded by the request deadline', async () => {
  assert.throws(() => new SumsubClient(config('http://127.0.0.1:1', { environment: 'production' })), /SUMSUB_ENVIRONMENT_INVALID/);
  const state: FixtureState = { requests: [], hangStatus: true, status: {} }; const http = await fixture(state);
  try {
    const client = new SumsubClient(config(http.url, { requestTimeoutMs: 100 }), fetch, () => NOW);
    await assert.rejects(client.evaluate(binding(client)), (error: unknown) => error instanceof SumsubError && /SUMSUB_(RESPONSE_INVALID|UNAVAILABLE)/.test(error.code));
  } finally { await http.close(); }
});
