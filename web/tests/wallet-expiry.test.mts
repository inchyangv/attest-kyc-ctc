import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

process.env.EVIDENCE_HMAC_KEY = 'synthetic-wallet-expiry-key-at-least-32-characters';
process.env.SERVER_TOKEN_KEY = 'synthetic-wallet-server-token-key-at-least-32-characters';
process.env.SERVER_TOKEN_KEY_ID = 'wallet-token-k1';
process.env.KYC_DEMO = '1';
globalThis.fetch = async () => { throw new Error('unexpected external request'); };
const { GET, POST } = await import('../app/api/kyc/wallet/route');
const { flowFromWalletToken, TokenError } = await import('../lib/kyc-server');
const { consentTextHash } = await import('../../pipeline/privacy-processing-policy');

test('wallet response expiry is the actual sealed session boundary; expired tokens remain server-rejected', async t => {
  const wallet = ethers.Wallet.createRandom();
  const challenge = await GET(new Request(`http://localhost/api/kyc/wallet?address=${wallet.address}`));
  assert.equal(challenge.status, 200); const input = await challenge.json();
  const response = await POST(new Request('http://localhost/api/kyc/wallet', { method: 'POST', headers: {
    origin: 'http://localhost', 'content-type': 'application/json',
  }, body: JSON.stringify({ token: input.token, signature: await wallet.signMessage(input.message) }) }));
  assert.equal(response.status, 200); const result = await response.json();
  const flow = flowFromWalletToken(result.walletProof);
  assert.equal(result.walletExpiresAt, flow.exp); assert.equal(flow.address, wallet.address);
  assert.equal(flow.consentStatementHash, consentTextHash(input.message.split('\n\n')[1]));
  assert.match(flow.consentStatementHash, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(flow.processingPolicy, input.processingPolicy);
  assert.deepEqual(flow.retentionPolicy, input.retentionPolicy);
  assert.deepEqual(result.processingPolicy, input.processingPolicy);
  assert.deepEqual(result.retentionPolicy, input.retentionPolicy);
  assert.match(input.message, new RegExp(input.processingPolicy.policyId));
  assert.ok(Number.isSafeInteger(result.serverTime) && result.walletExpiresAt > result.serverTime);
  assert.ok(result.walletExpiresAt - result.serverTime <= 1800000);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  t.mock.method(Date, 'now', () => result.walletExpiresAt + 1);
  assert.throws(() => flowFromWalletToken(result.walletProof), TokenError);
});

test('production wallet challenge fails before consent when no approved processing manifest exists', async () => {
  const demo = process.env.KYC_DEMO;
  const policy = process.env.PROCESSING_POLICY_JSON;
  try {
    process.env.KYC_DEMO = '0';
    delete process.env.PROCESSING_POLICY_JSON;
    const response = await GET(new Request(`http://localhost/api/kyc/wallet?address=${ethers.Wallet.createRandom().address}`));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'CONFIGURATION_UNAVAILABLE');
    assert.deepEqual(body.missing, ['PROCESSING_POLICY_JSON']);
    assert.equal(body.token, undefined);
    assert.equal(body.message, undefined);
  } finally {
    if (demo === undefined) delete process.env.KYC_DEMO; else process.env.KYC_DEMO = demo;
    if (policy === undefined) delete process.env.PROCESSING_POLICY_JSON; else process.env.PROCESSING_POLICY_JSON = policy;
  }
});

test('production wallet challenge fails before consent and vendor work when retention policy is missing', async () => {
  const demo = process.env.KYC_DEMO;
  const processingRaw = process.env.PROCESSING_POLICY_JSON;
  const retentionRaw = process.env.RETENTION_POLICY_JSON;
  const { SYNTHETIC_PROCESSING_POLICY } = await import('../../pipeline/privacy-processing-policy.js');
  const synthetic = structuredClone(SYNTHETIC_PROCESSING_POLICY);
  const approved = {
    ...synthetic, status: 'approved', approvalRef: 'approval:privacy:test', legalReviewRef: 'legal:privacy:test',
    contractRef: 'contract:privacy:test',
    residentIdentifier: { ...synthetic.residentIdentifier, mode: 'authorized', authorityRef: 'authority:rrn:test' },
    onchain: { ...synthetic.onchain, publicationBasisRef: 'basis:onchain:test' },
  };
  try {
    process.env.KYC_DEMO = '0';
    process.env.PROCESSING_POLICY_JSON = JSON.stringify(approved);
    delete process.env.RETENTION_POLICY_JSON;
    const response = await GET(new Request(`http://localhost/api/kyc/wallet?address=${ethers.Wallet.createRandom().address}`));
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body.missing, ['RETENTION_POLICY_JSON']);
    assert.equal(body.token, undefined);
    assert.equal(body.message, undefined);
  } finally {
    if (demo === undefined) delete process.env.KYC_DEMO; else process.env.KYC_DEMO = demo;
    if (processingRaw === undefined) delete process.env.PROCESSING_POLICY_JSON; else process.env.PROCESSING_POLICY_JSON = processingRaw;
    if (retentionRaw === undefined) delete process.env.RETENTION_POLICY_JSON; else process.env.RETENTION_POLICY_JSON = retentionRaw;
  }
});
