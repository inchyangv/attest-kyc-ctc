import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SYNTHETIC_PROCESSING_POLICY, policyBinding } from '../../pipeline/privacy-processing-policy';
import { SYNTHETIC_RETENTION_POLICY, retentionPolicyBinding } from '../../pipeline/retention-policy';

// This process must never load vendor credentials or make an external bank/network request.
for (const name of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_|BANK_STATE_)/.test(name)) delete process.env[name];
process.env.KYC_DEMO = '1'; process.env.KYC_DEMO_BITS = '1';
process.env.EVIDENCE_HMAC_KEY = 'synthetic-bank-route-key-at-least-32-characters';
process.env.SERVER_TOKEN_KEY = 'synthetic-bank-server-token-key-at-least-32-characters';
process.env.SERVER_TOKEN_KEY_ID = 'bank-token-k1';
globalThis.fetch = async () => { throw new Error('unexpected external request in isolated API test'); };
const { POST } = await import('../app/api/kyc/bank/route');
const { seal, open, CONSENT_VERSION, getAdapter } = await import('../lib/kyc-server');
const { bankStateStore } = await import('../lib/bank-state');

function flow() {
  const address = `0x${randomUUID().replaceAll('-', '').padEnd(40, 'a')}`;
  return seal('wallet', { address, flowId: randomUUID(), consentVersion: CONSENT_VERSION,
    consentStatementHash: `0x${'11'.repeat(32)}`,
    processingPolicy: policyBinding(SYNTHETIC_PROCESSING_POLICY),
    retentionPolicy: retentionPolicyBinding(SYNTHETIC_RETENTION_POLICY), at: Date.now() }, 1800);
}
async function post(body: object, ip: string) {
  const response = await POST(new Request('http://localhost/api/kyc/bank', { method: 'POST', headers: {
    'content-type': 'application/json', origin: 'http://localhost', 'x-forwarded-for': ip,
  }, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json(), headers: response.headers };
}
let account = 12345000;
const start = (walletProof: string, extra = {}) => ({ action: 'start', walletProof, bankCode: '004',
  accountNumber: String(account++), birthDate: '900101', declaredName: 'Synthetic Test', ...extra });

test('sample bank start and confirmation reject mode drift before lookups or consuming a code', async () => {
  const walletProof = flow(); const input = start(walletProof, { syntheticSample: true });
  const first = await post(input, randomUUID()); assert.equal(first.status, 200); assert.equal(first.body.live, false);
  const { adapter } = getAdapter(); const original = adapter.lookupHolder; let calls = 0;
  adapter.lookupHolder = async () => { calls++; throw new Error('sample must not reach a bank'); };
  try {
    process.env.KYC_DEMO = '0';
    const blocked = await post(start(flow(), { syntheticSample: true }), randomUUID());
    assert.equal(blocked.status, 409); assert.equal(blocked.body.code, 'SYNTHETIC_SAMPLE_UNAVAILABLE');
    const confirm = { action: 'verify', walletProof, challenge: first.body.challenge, code: first.body.demoCode, syntheticSample: true };
    assert.equal((await post(confirm, randomUUID())).status, 409);
    process.env.KYC_DEMO = '1';
    assert.equal((await post(confirm, randomUUID())).status, 200, 'rejected mode drift must not consume the challenge');
    assert.equal(calls, 0);
  } finally { process.env.KYC_DEMO = '1'; adapter.lookupHolder = original; }
});

test('same original sealed challenge is locked after five wrong codes; correct code then fails', async () => {
  const walletProof = flow(); const ip = randomUUID();
  const started = await post(start(walletProof), ip);
  assert.equal(started.status, 200); assert.equal(started.body.stateMode, 'demo-memory');
  const wrong = started.body.demoCode === '0000' ? '1111' : '0000';
  for (let i = 0; i < 5; i++) {
    const result = await post({ action: 'verify', walletProof, challenge: started.body.challenge, code: wrong }, ip);
    assert.equal(result.status, 422);
    assert.equal(result.body.code, i === 4 ? 'TOO_MANY_ATTEMPTS' : 'CODE_MISMATCH');
    if (i < 4) assert.equal(result.body.challenge, started.body.challenge);
  }
  const result = await post({ action: 'verify', walletProof, challenge: started.body.challenge, code: started.body.demoCode }, ip);
  assert.equal(result.body.code, 'TOO_MANY_ATTEMPTS');
});

test('pristine challenge replay from distinct request origins shares one five-failure budget', async () => {
  const walletProof = flow();
  const started = await post(start(walletProof), randomUUID());
  assert.equal(started.status, 200);
  const pristineChallenge = started.body.challenge;
  const wrong = started.body.demoCode === '0000' ? '1111' : '0000';
  let fifth: Awaited<ReturnType<typeof post>> | undefined;
  for (let i = 0; i < 5; i++) {
    fifth = await post({ action: 'verify', walletProof, challenge: pristineChallenge, code: wrong }, randomUUID());
  }
  assert.equal(fifth?.status, 422);
  assert.equal(fifth?.body.code, 'TOO_MANY_ATTEMPTS');
  const correct = await post({ action: 'verify', walletProof, challenge: pristineChallenge, code: started.body.demoCode }, randomUUID());
  assert.equal(correct.status, 422);
  assert.equal(correct.body.code, 'TOO_MANY_ATTEMPTS');
});

test('start retry returns the original token, verification has one winner, different flow rejected', async () => {
  const walletProof = flow(); const ip = randomUUID(); const input = start(walletProof);
  const first = await post(input, ip); const retry = await post(input, ip);
  assert.equal(first.status, 200); assert.deepEqual(retry.body, first.body);
  const payload = { action: 'verify', walletProof, challenge: first.body.challenge, code: first.body.demoCode };
  assert.equal((await post({ ...payload, walletProof: flow() }, ip)).status, 400);
  const results = await Promise.all(Array.from({ length: 8 }, () => post(payload, ip)));
  assert.equal(results.filter(r => r.status === 200 && r.body.bankProof).length, 1);
  assert.equal(results.filter(r => r.body.code === 'CHALLENGE_UNAVAILABLE').length, 7);
});

test('PM-T35-01 shared built-in sample account has per-wallet capacity while unmarked accounts keep the shared budget', async () => {
  const markedAccount = '000000001234';
  for (let i = 0; i < 4; i++) {
    const result = await post(start(flow(), {
      syntheticSample: true, accountNumber: markedAccount, startRequestId: `sample-visitor-${i}`,
    }), randomUUID());
    assert.equal(result.status, 200, `synthetic visitor ${i + 1} must not consume another visitor's fixture-account capacity`);
  }

  const unmarkedAccount = '000000009876';
  for (let i = 0; i < 3; i++) {
    assert.equal((await post(start(flow(), { accountNumber: unmarkedAccount, startRequestId: `ordinary-${i}` }), randomUUID())).status, 200);
  }
  const bounded = await post(start(flow(), { accountNumber: unmarkedAccount, startRequestId: 'ordinary-3' }), randomUUID());
  assert.equal(bounded.status, 429);
  assert.equal(bounded.body.code, 'START_BUDGET_EXCEEDED');
});

test('deliberate new start invalidates old challenge and legacy token is rejected', async () => {
  const walletProof = flow(); const ip = randomUUID(); const input = start(walletProof);
  const first = await post({ ...input, startRequestId: 'first' }, ip);
  const { challengeId: _id, requestKey: _key, ...legacy } = open<Record<string, unknown>>('bankChallenge', first.body.challenge);
  void _id; void _key;
  assert.equal((await post({ action: 'verify', walletProof, challenge: seal('bankChallenge', legacy, 600), code: first.body.demoCode }, ip)).status, 400);
  const second = await post({ ...input, startRequestId: 'second' }, ip);
  assert.equal(second.status, 200);
  assert.equal((await post({ action: 'verify', walletProof, challenge: first.body.challenge, code: first.body.demoCode }, ip)).body.code, 'CHALLENGE_UNAVAILABLE');
  assert.equal((await post({ action: 'verify', walletProof, challenge: second.body.challenge, code: second.body.demoCode }, ip)).status, 200);
});

test('actual rails cannot use demo memory, partial Redis config never falls back', () => {
  assert.throws(() => bankStateStore(false), /requires shared atomic/);
  process.env.BANK_STATE_REDIS_REST_URL = 'https://synthetic-redis.test';
  try { assert.throws(() => bankStateStore(true), /requires shared atomic/); }
  finally { delete process.env.BANK_STATE_REDIS_REST_URL; }
});

test('bank failures do not reveal provider diagnostics, third-party holder names or reference values', async () => {
  const { VendorError } = createRequire(import.meta.url)('../../pipeline/adapters/kr.ts') as typeof import('../../pipeline/adapters/kr');
  const { adapter } = getAdapter(); const original = adapter.lookupHolder; const secret = 'SYNTHETIC_PRIVATE_9001011234567';
  try {
    adapter.lookupHolder = async () => { throw new VendorError(secret, 'A0021', secret); };
    let response = await post(start(flow()), randomUUID());
    assert.equal(response.status, 422); assert.equal(response.body.code, 'A0021'); assert.equal(response.body.ref, null);
    assert.ok(!JSON.stringify(response.body).includes(secret)); assert.equal(response.headers.get('cache-control'), 'no-store');
    adapter.lookupHolder = async () => ({ holderName: secret, matches: false, ref: secret });
    response = await post(start(flow()), randomUUID());
    assert.equal(response.status, 422); assert.equal(response.body.code, 'HOLDER_MISMATCH'); assert.equal(response.body.ref, null);
    assert.equal(response.body.error, 'The bank account holder does not match the declared identity.');
  } finally { adapter.lookupHolder = original; }
});

test('actual connector timeout keeps the bank reservation pending and returns no challenge or automatic replay', async () => {
  // Route modules are loaded through tsx's CJS graph in this non-type:module web package.
  const { CodefClient, CodefBankAccountVendor } = createRequire(import.meta.url)('../../pipeline/adapters/codef.ts') as typeof import('../../pipeline/adapters/codef');
  let tokens = 0; let deposits = 0;
  const connector = new CodefBankAccountVendor(new CodefClient({ clientId: 'synthetic', clientSecret: 'synthetic', env: 'api', productTimeoutMs: 10,
    fetch: async (url, init) => {
      if (String(url).includes('oauth')) { tokens++; return Response.json({ access_token: 'synthetic', expires_in: 3600 }); }
      deposits++;
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout, unknown deposit result'))));
    },
  }));
  // Keep demo-memory admission in this isolated test; only delegate the transport to the real connector with fake fetch.
  const { adapter } = getAdapter(); const holder = adapter.lookupHolder; const send = adapter.sendOneWon;
  adapter.lookupHolder = async () => ({ holderName: 'Synthetic Test', matches: true });
  adapter.sendOneWon = input => connector.oneWonTransfer(input);
  try {
    const input = start(flow()); const ip = randomUUID();
    const result = await post(input, ip);
    assert.equal(result.status, 503); assert.equal(result.body.code, 'VENDOR_TIMEOUT');
    assert.equal(result.body.outcome, 'unconfirmed'); assert.equal(result.body.automaticRetry, false);
    assert.equal(result.body.challenge, undefined); assert.equal(result.body.bankProof, undefined);
    const repeated = await post(input, ip);
    assert.equal(repeated.status, 422); assert.equal(repeated.body.code, 'START_PENDING');
    assert.equal(deposits, 1); assert.equal(tokens, 1);
  } finally { adapter.lookupHolder = holder; adapter.sendOneWon = send; }
});
