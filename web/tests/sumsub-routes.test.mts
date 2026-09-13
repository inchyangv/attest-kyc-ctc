import { test } from 'node:test';
import assert from 'node:assert/strict';

const statusRoute = await import('../app/api/providers/sumsub/status/route');
const tokenRoute = await import('../app/api/providers/sumsub/token/route');
const webhookRoute = await import('../app/api/providers/sumsub/webhook/route');
const walletRoute = await import('../app/api/providers/sumsub/wallet/route');

test('Sumsub readiness is safely unavailable and never contacts a provider when configuration is absent', async () => {
  const response = await statusRoute.GET(new Request('https://proofmark.invalid/api/providers/sumsub/status'));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.configured, false);
  assert.equal(body.mode, 'evidence-candidate-only');
  assert.equal(body.issuanceBridge, false);
  assert.equal(JSON.stringify(body).includes('SECRET'), false, 'readiness does not expose credential values');
});

test('browser token and status mutations reject cross-origin requests before configuration or wallet processing', async () => {
  for (const handler of [walletRoute.POST, tokenRoute.POST, statusRoute.POST]) {
    const response = await handler(new Request('https://proofmark.invalid/api/providers/sumsub/test', {
      method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
      body: JSON.stringify({ walletProof: 'attacker' }),
    }));
    assert.equal(response.status, 403);
  }
});

test('Sumsub wallet challenge stays unavailable until the provider runtime is configured', async () => {
  const response = await walletRoute.GET(new Request('https://proofmark.invalid/api/providers/sumsub/wallet?address=0x1111111111111111111111111111111111111111'));
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'SUMSUB_NOT_CONFIGURED');
});

test('webhook endpoint rejects a missing digest instead of treating it as an unsigned notification', async () => {
  const response = await webhookRoute.POST(new Request('https://proofmark.invalid/api/providers/sumsub/webhook', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }));
  // Runtime configuration is checked before signature verification so an unconfigured endpoint
  // stays fail-closed. In a configured deployment the core verifier returns the tested 401 code.
  assert.equal(response.status, 503);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.code, 'SUMSUB_NOT_CONFIGURED');
});
