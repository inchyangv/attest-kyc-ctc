import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { publicVendorFailure, publicConfigFailure } = require('../lib/public-errors.ts') as typeof import('../lib/public-errors');
const { privateJson } = require('../lib/private-response.ts') as typeof import('../lib/private-response');
const { VendorError } = require('../../pipeline/adapters/kr.ts') as typeof import('../../pipeline/adapters/kr');
const { VendorTransportError } = require('../../pipeline/adapters/vendor-http.ts') as typeof import('../../pipeline/adapters/vendor-http');
const { ConfigError } = require('../lib/kyc-server.ts') as typeof import('../lib/kyc-server');
const sensitive = 'SYNTHETIC_PRIVATE_9001011234567_홍길동_계좌_인증서_SECRET';

test('provider failure projection drops messages, refs, causes and arbitrary codes without changing the source error', async () => {
  for (const code of ['CF-13001', 'A0021', '301', 'BAD_INPUT', 'NO_CODE', sensitive, '__proto__', 'constructor']) {
    const error = new VendorError(sensitive, code, sensitive);
    error.cause = { rawResponse: sensitive }; error.stack = sensitive;
    const response = publicVendorFailure(error)!; const body = await response.json();
    assert.equal(response.status, 422); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(body).includes(sensitive)); assert.equal(body.ref, null);
    assert.equal(body.code, [sensitive, '__proto__', 'constructor'].includes(code) ? 'VENDOR_FAILURE' : code);
    assert.equal(error.message, sensitive); assert.equal(error.ref, sensitive); assert.equal(error.code, code);
  }
});

test('transport and unavailable failures use fixed diagnostics, not mutable Error text', async () => {
  const error = new VendorTransportError('VENDOR_TIMEOUT', 503); error.message = sensitive;
  const response = publicVendorFailure(error)!; const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.outcome, 'unconfirmed'); assert.equal(body.automaticRetry, false);
  assert.equal(body.code, 'VENDOR_TIMEOUT'); assert.ok(!JSON.stringify(body).includes(sensitive));
  assert.equal(response.headers.get('retry-after'), null);
  for (const code of ['NO_VENDOR', 'NO_OCR', 'NO_PUBLIC_KEY']) {
    const response = publicVendorFailure(new VendorError(sensitive, code, sensitive))!;
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'VENDOR_UNAVAILABLE');
  }
  assert.equal(publicVendorFailure(new Error(sensitive)), null);
});

test('configuration failures expose only catalogued variable names and a valid request identifier', async () => {
  const error = new ConfigError(sensitive, [sensitive, 'CODEF_ENV', 'CODEF_ENV']);
  let response = publicConfigFailure(error, sensitive)!; let body = await response.json();
  assert.equal(response.status, 503); assert.deepEqual(body.missing, ['CODEF_ENV']); assert.equal(body.requestId, undefined);
  assert.ok(!JSON.stringify(body).includes(sensitive)); assert.equal(error.message, sensitive);
  response = publicConfigFailure(error, '0x' + 'ab'.repeat(32))!; body = await response.json();
  assert.equal(body.requestId, '0x' + 'ab'.repeat(32));
});

test('private response always overrides caller cache headers for success and failure', () => {
  for (const status of [200, 400, 422, 503]) {
    const response = privateJson({ ok: status === 200 }, { status, headers: { 'Cache-Control': 'public, max-age=600', 'X-Test': 'retained' } });
    assert.equal(response.status, status); assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('pragma'), 'no-cache'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-test'), 'retained');
  }
});

test('actual screen and KYC status routes hide filesystem failure paths and do not log raw errors', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'PRIVATE_SCOPE_'));
  const previous = process.cwd();
  const logged: unknown[] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  t.mock.method(console, 'warn', (...args: unknown[]) => { logged.push(args); });
  t.mock.method(console, 'log', (...args: unknown[]) => { logged.push(args); });
  const screen = require('../app/api/screen/route.ts') as typeof import('../app/api/screen/route');
  const status = require('../app/api/kyc/status/route.ts') as typeof import('../app/api/kyc/status/route');
  const { getEngine } = require('../lib/aml-server.ts') as typeof import('../lib/aml-server');
  process.env.EVIDENCE_HMAC_KEY = 'synthetic-private-error-test-key-at-least-32-chars';
  process.env.KYC_DEMO = '1';
  try {
    process.chdir(directory);
    assert.throws(() => getEngine(), /PRIVATE_SCOPE_/, 'premise: native failure contains private filesystem location');
    const responses = [await screen.GET(new Request('http://localhost/api/screen')), await status.GET(new Request('http://localhost/api/kyc/status')),
      await screen.POST(new Request('http://localhost/api/screen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fullName: sensitive }) }))];
    for (const response of responses) {
      assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
      const text = await response.text(); assert.ok(!text.includes('PRIVATE_SCOPE_') && !text.includes(sensitive));
      assert.ok(!text.includes('ENOENT') && !text.includes('sanctions-index'));
    }
    assert.deepEqual(logged, []);
  } finally { process.chdir(previous); rmSync(directory, { recursive: true, force: true }); }
});

test('fresh configuration builders do not reflect unknown environment values or silently select a test bank', () => {
  const web = fileURLToPath(new URL('../', import.meta.url));
  const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
  const run = (extra: Record<string, string>) => JSON.parse(execFileSync(process.execPath, ['--conditions=react-server', '--import', loader, '-e',
    "globalThis.fetch=async()=>{throw Error('no external requests')};process.stdout.write(JSON.stringify(require('./lib/kyc-server.ts').getAdapter().status))"], {
    cwd: web, encoding: 'utf8', timeout: 5000, env: { NODE_ENV: 'test', TSX_TSCONFIG_PATH: join(web, 'tsconfig.json'), KYC_DEMO: '0',
      CODEF_CLIENT_ID: 'synthetic', CODEF_CLIENT_SECRET: 'synthetic', CODEF_PUBLIC_KEY: 'synthetic', CODEF_CERT_FILE: 'synthetic',
      CODEF_CERT_PASSWORD: 'synthetic', CODEF_LOGIN_USER_NAME: 'Synthetic', CODEF_LOGIN_IDENTITY: '1234567890123', ...extra },
  }));
  const first = run({ CODEF_ENV: sensitive, BANK_VENDOR: sensitive });
  assert.equal(first.id.configured, false); assert.equal(first.id.env, null); assert.equal(first.bank.configured, false);
  assert.ok(!JSON.stringify(first).includes(sensitive));
  const second = run({ CODEF_ENV: 'sandbox', BANK_VENDOR: 'openbanking', OPENBANKING_ENV: sensitive });
  assert.equal(second.bank.configured, false); assert.equal(second.bank.env, null);
  assert.deepEqual(second.bank.missing, ['OPENBANKING_ENV']); assert.ok(!JSON.stringify(second).includes(sensitive));
});
