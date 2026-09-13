import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

for (const key of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_|ISSUER_|EVIDENCE_|VAULT_|BANK_STATE_|ISSUANCE_JOURNAL_)/.test(key)) delete process.env[key];
process.env.KYC_DEMO = '1';
delete process.env.SANCTIONS_TRAINING_ENABLED;
globalThis.fetch = async () => { throw new Error('training must not access an external service'); };
const { POST } = await import('../app/api/demo/screen/route');
async function request(body: unknown, extra: Record<string, string> = {}) {
  const res = await POST(new Request('http://localhost/api/demo/screen', { method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': randomUUID(), ...extra }, body: JSON.stringify(body) }));
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('actual training route works without credentials, wallet or current official snapshot and returns only training results', async () => {
  for (const [scenario, expected] of [['full-match', 'BLOCK'], ['name-only', 'REVIEW'], ['dob-conflict', 'REVIEW'], ['no-match', 'ALLOW']]) {
    const r = await request({ scenario }); assert.equal(r.status, 200); assert.equal(r.body.trainingDecision, expected);
    assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.body.officialListsChecked, false);
    assert.equal(r.body.eligibleForIssuance, false); assert.equal(r.body.walletProof, undefined); assert.equal(r.body.methodsApplied, undefined);
  }
});

test('training route rejects personal fields, arbitrary scenarios, foreign origin and oversized bodies without reflecting them', async () => {
  const secret = 'SYNTHETIC_PRIVATE_INPUT_NEVER_REFLECT';
  for (const body of [{ scenario: 'full-match', fullName: secret }, { scenario: 'full-match', walletProof: secret },
    { scenario: secret }, {}, [], { scenario: 1 }]) {
    const r = await request(body); assert.equal(r.status, 400); assert.ok(!JSON.stringify(r.body).includes(secret));
  }
  assert.equal((await request({ scenario: 'full-match' }, { origin: 'https://foreign.test' })).status, 403);
  assert.equal((await request({ scenario: 'a'.repeat(1025) })).status, 413);
});

test('training route is unavailable outside demo mode and enforces its own bounded rate bucket', async () => {
  process.env.KYC_DEMO = '0';
  try { const r = await request({ scenario: 'full-match' }); assert.equal(r.status, 404); assert.equal(r.body.trainingDecision, undefined); }
  finally { process.env.KYC_DEMO = '1'; }
  const headers = { 'x-forwarded-for': randomUUID() };
  for (let i = 0; i < 20; i++) assert.equal((await request({ scenario: 'no-match' }, headers)).status, 200);
  const r = await request({ scenario: 'no-match' }, headers); assert.equal(r.status, 429); assert.ok(r.headers.get('retry-after'));
});

test('training JSON cannot be used as an issuance wallet proof', async () => {
  const training = await request({ scenario: 'no-match' });
  process.env.EVIDENCE_HMAC_KEY = 'synthetic-training-route-at-least-32-characters';
  const { POST: issue } = await import('../app/api/kyc/issue/route');
  const res = await issue(new Request('http://localhost/api/kyc/issue', { method: 'POST',
    headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-forwarded-for': randomUUID() },
    body: JSON.stringify({ walletProof: JSON.stringify(training.body) }) }));
  assert.equal(res.status, 400); const body = await res.json();
  assert.equal(body.requestId, undefined); assert.equal(body.onchain, undefined);
  delete process.env.EVIDENCE_HMAC_KEY;
});

test('explicit education flag works alongside non-demo provider mode without accepting personal inputs or minting', async () => {
  process.env.KYC_DEMO = '0';
  process.env.SANCTIONS_TRAINING_ENABLED = '1';
  try {
    const result = await request({ scenario: 'no-match' });
    assert.equal(result.status, 200);
    assert.equal(result.body.eligibleForIssuance, false);
    assert.equal(result.body.officialListsChecked, false);
    assert.equal(result.body.walletProof, undefined);
    assert.equal((await request({ scenario: 'no-match', fullName: 'fictional-user' })).status, 400);
    process.env.SANCTIONS_TRAINING_ENABLED = 'true';
    assert.equal((await request({ scenario: 'no-match' })).status, 404);
  } finally { process.env.KYC_DEMO = '1'; delete process.env.SANCTIONS_TRAINING_ENABLED; }
});
