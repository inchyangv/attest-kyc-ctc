import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { keccak256 } from 'ethers';
import { SYNTHETIC_PROCESSING_POLICY, policyBinding } from '../../pipeline/privacy-processing-policy';
import { SYNTHETIC_RETENTION_POLICY, retentionPolicyBinding } from '../../pipeline/retention-policy';

for (const name of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_)/.test(name)) delete process.env[name];
process.env.KYC_DEMO = '1'; process.env.KYC_DEMO_BITS = '1';
process.env.EVIDENCE_HMAC_KEY = 'synthetic-document-test-only-at-least-32-chars';
process.env.SERVER_TOKEN_KEY = 'synthetic-document-server-token-key-at-least-32-chars';
process.env.SERVER_TOKEN_KEY_ID = 'document-token-k1';
globalThis.fetch = async () => { throw new Error('unexpected external document request'); };
const { POST } = await import('../app/api/kyc/id/route');
const { seal, CONSENT_VERSION, getAdapter } = await import('../lib/kyc-server');
const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'white' } }).png().toBuffer();
const wallet = { address: '0x1111111111111111111111111111111111111111', flowId: randomUUID(), consentVersion: CONSENT_VERSION,
  consentStatementHash: `0x${'11'.repeat(32)}`,
  processingPolicy: policyBinding(SYNTHETIC_PROCESSING_POLICY),
  retentionPolicy: retentionPolicyBinding(SYNTHETIC_RETENTION_POLICY), at: Date.now() };
const walletProof = seal('wallet', wallet, 1800);
async function post(input: Buffer, mime: string, fields: Record<string, string> = {}) {
  const form = new FormData(); form.set('walletProof', walletProof); form.set('action', 'ocr'); form.set('docType', 'RRC');
  form.set('image', new File([new Uint8Array(input)], 'synthetic-image', { type: mime }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  const response = await POST(new Request('http://localhost/api/kyc/id', { method: 'POST', body: form,
    headers: { origin: 'http://localhost', 'x-forwarded-for': randomUUID() } }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test('ID route validates actual image before OCR and retains the original docHash', async () => {
  const result = await post(png, 'image/png');
  assert.equal(result.status, 200); assert.equal(result.body.docHash, keccak256(png));
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('ID route never reflects private provider diagnostics from OCR or verification failures', async () => {
  const { VendorError } = createRequire(import.meta.url)('../../pipeline/adapters/kr.ts') as typeof import('../../pipeline/adapters/kr');
  const { adapter } = getAdapter(); const read = adapter.readIdDocument; const verify = adapter.verifyIdDocument;
  const secret = 'SYNTHETIC_PRIVATE_9001011234567_홍길동';
  adapter.readIdDocument = adapter.verifyIdDocument = async () => { throw new VendorError(secret, 'CF-13001', secret); };
  try {
    for (const action of ['ocr', 'verify']) {
      const response = await post(png, 'image/png', { action });
      assert.equal(response.status, 422); assert.equal(response.body.code, 'CF-13001'); assert.equal(response.body.ref, null);
      assert.ok(!JSON.stringify(response.body).includes(secret)); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  } finally { adapter.readIdDocument = read; adapter.verifyIdDocument = verify; }
});

test('two-way messages are fixed guidance; unsupported methods cannot be reflected or sealed', async () => {
  const { adapter } = getAdapter(); const original = adapter.verifyIdDocument;
  const secret = 'SYNTHETIC_PRIVATE_9001011234567';
  let method = 'secureNo';
  adapter.verifyIdDocument = async () => ({ kind: 'two_way', challenge: { method, message: secret,
    jobIndex: 0, threadIndex: 1, jti: 'synthetic-only', twoWayTimestamp: Date.now(), imageBase64: png.toString('base64') } });
  try {
    for (method of ['secureNo', 'simpleAuth']) {
      const response = await post(png, 'image/png', { action: 'verify' });
      assert.equal(response.status, 200); assert.equal(response.body.challenge.method, method);
      assert.ok(!JSON.stringify(response.body).includes(secret)); assert.equal(typeof response.body.twoWayToken, 'string');
    }
    method = secret;
    const response = await post(png, 'image/png', { action: 'verify' });
    assert.equal(response.status, 503); assert.equal(response.body.twoWayToken, undefined);
    assert.ok(!JSON.stringify(response.body).includes(secret));
  } finally { adapter.verifyIdDocument = original; }
});

test('ID verification retains original image hash and explicit non-live demo provenance', async () => {
  const result = await post(png, 'image/png', { action: 'verify', fullName: 'Synthetic Person', birthDate: '19900101',
    rrn: '9001011234567', issueDate: '20240101' });
  assert.equal(result.status, 200); assert.equal(result.body.status, 'verified');
  assert.equal(result.body.summary.docHash, keccak256(png));
  assert.equal(result.body.summary.live, false); assert.equal(result.body.summary.vendor, 'demo:id');
});

test('ID route rejects invalid image/action/type before invoking a vendor', async () => {
  const { adapter } = getAdapter();
  const oldRead = adapter.readIdDocument; const oldVerify = adapter.verifyIdDocument;
  let calls = 0;
  adapter.readIdDocument = async () => { calls++; throw new Error('unexpected OCR call'); };
  adapter.verifyIdDocument = async () => { calls++; throw new Error('unexpected verification call'); };
  try {
    assert.equal((await post(Buffer.from('<svg/>'), 'image/svg+xml')).status, 415);
    assert.equal((await post(Buffer.from('<svg/>'), 'image/png', { action: 'verify' })).status, 422);
    assert.equal((await post(png, 'image/png', { action: 'typo' })).status, 400);
    assert.equal((await post(png, 'image/png', { docType: 'UNKNOWN' })).status, 400);
    assert.equal(calls, 0);
  } finally { adapter.readIdDocument = oldRead; adapter.verifyIdDocument = oldVerify; }
});

test('validated replacement image cannot reuse a two-way continuation for different bytes', async () => {
  const twoWayToken = seal('idTwoWay', { flowId: wallet.flowId, walletAddress: wallet.address,
    docHash: keccak256(Buffer.from('another synthetic image')), jobIndex: 0, threadIndex: 0, jti: 'synthetic', twoWayTimestamp: Date.now() }, 170);
  const response = await post(png, 'image/png', { action: 'verify', twoWayToken });
  assert.equal(response.status, 400); assert.match(response.body.error, /document changed/);
});

test('ID connector timeout is unconfirmed service failure, never a rejected or verified ID proof', async () => {
  const { CodefClient, CodefIdDocumentVendor } = createRequire(import.meta.url)('../../pipeline/adapters/codef.ts') as typeof import('../../pipeline/adapters/codef');
  let products = 0;
  const vendor = new CodefIdDocumentVendor(new CodefClient({ clientId: 'synthetic', clientSecret: 'synthetic', env: 'sandbox', productTimeoutMs: 10,
    fetch: async (url, init) => {
      if (String(url).includes('oauth')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
      products++; return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-only'))));
    },
  }), { certType: 'pfx', certFile: 'synthetic', certPassword: 'synthetic', loginUserName: 'Synthetic', loginIdentity: 'synthetic' });
  const { adapter } = getAdapter(); const original = adapter.readIdDocument;
  adapter.readIdDocument = (image, type) => vendor.ocr(image, type);
  try {
    const result = await post(png, 'image/png');
    assert.equal(result.status, 503); assert.equal(result.body.code, 'VENDOR_TIMEOUT');
    assert.equal(result.body.outcome, 'unconfirmed'); assert.equal(result.body.automaticRetry, false);
    assert.equal(result.body.idProof, undefined); assert.equal(result.body.status, undefined); assert.equal(products, 1);
  } finally { adapter.readIdDocument = original; }
});

test('sample ID route uses actual demo verification and rejects mode drift before any vendor call', async () => {
  const result = await post(png, 'image/png', { syntheticSample: '1', action: 'verify', fullName: 'PROOFMARK SAMPLE PERSON',
    birthDate: '20000101', rrn: '0001010000001', issueDate: '20240101' });
  assert.equal(result.status, 200); assert.equal(result.body.summary.vendor, 'demo:id'); assert.equal(result.body.summary.live, false);
  const { adapter } = getAdapter(); const original = adapter.readIdDocument; let calls = 0;
  adapter.readIdDocument = async () => { calls++; throw new Error('sample must not reach a provider'); };
  try {
    process.env.KYC_DEMO = '0';
    const drift = await post(png, 'image/png', { syntheticSample: '1' });
    assert.equal(drift.status, 409); assert.equal(drift.body.code, 'SYNTHETIC_SAMPLE_UNAVAILABLE');
    assert.equal(drift.headers.get('cache-control'), 'no-store');
    process.env.KYC_DEMO = '1';
    assert.equal((await post(png, 'image/png', { syntheticSample: 'typo' })).status, 409);
    assert.equal(calls, 0);
  } finally { process.env.KYC_DEMO = '1'; adapter.readIdDocument = original; }
});

test('PM-T32-01 policy/vendor/transfer drift is rejected before document data reaches a vendor', async () => {
  const { adapter } = getAdapter();
  const original = adapter.verifyIdDocument;
  let calls = 0;
  adapter.verifyIdDocument = async () => { calls++; throw new Error('processing-policy drift reached the vendor'); };
  const previous = process.env.PROCESSING_POLICY_JSON;
  process.env.PROCESSING_POLICY_JSON = JSON.stringify({
    ...SYNTHETIC_PROCESSING_POLICY,
    policyId: 'customer-changed-processing-v2', customerId: 'customer-changed', status: 'approved',
    controllerId: 'customer-changed-controller', approvalRef: 'approval:changed:v2',
    legalReviewRef: 'legal:changed:v2', contractRef: 'contract:changed:v2',
    notice: { ...SYNTHETIC_PROCESSING_POLICY.notice, version: 'customer-changed-notice-v2' },
    residentIdentifier: { ...SYNTHETIC_PROCESSING_POLICY.residentIdentifier, mode: 'authorized',
      authorityRef: 'legal:changed:rrn:v2', noticeRef: 'notice:changed:rrn:v2' },
    onchain: { ...SYNTHETIC_PROCESSING_POLICY.onchain, publicationBasisRef: 'legal:changed:onchain:v2' },
    flows: SYNTHETIC_PROCESSING_POLICY.flows.map(flow => flow.stage === 'id_document'
      ? { ...flow, recipient: 'new-id-vendor', countries: ['US'] }
      : flow),
  });
  try {
    process.env.KYC_DEMO = '0';
    const response = await post(png, 'image/png', { action: 'verify', fullName: 'Synthetic Person',
      birthDate: '19900101', rrn: '9001011234567', issueDate: '20240101' });
    assert.equal(response.status, 400);
    assert.match(response.body.error, /processing policy changed/);
    assert.equal(calls, 0);
  } finally {
    process.env.KYC_DEMO = '1';
    if (previous === undefined) delete process.env.PROCESSING_POLICY_JSON;
    else process.env.PROCESSING_POLICY_JSON = previous;
    adapter.verifyIdDocument = original;
  }
});
