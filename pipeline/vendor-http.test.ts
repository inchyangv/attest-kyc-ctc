import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { VendorHttp, VendorTokenCache, VendorTransportError, VENDOR_HTTP_LIMITS, vendorTimeouts } from './adapters/vendor-http.js';
import { CodefClient, CodefBankAccountVendor } from './adapters/codef.js';
import { OpenBankingAccountVendor } from './adapters/openbanking.js';

const isCode = (code: string) => (e: unknown) => e instanceof VendorTransportError && e.code === code;
const options = { timeoutMs: 100, maxBytes: 1024 };
const url = 'https://synthetic-vendor.invalid/product';
const bytes = (s: string) => new TextEncoder().encode(s);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('vendor HTTP counts actual decoded bytes, exact limits, headers, UTF-8 and chunks', async () => {
  for (const [response, code] of [
    [new Response('x'.repeat(1025)), 'VENDOR_RESPONSE_LIMIT'],
    [new Response('xx', { headers: { 'content-length': '1' } }), 'VENDOR_BAD_RESPONSE'],
    [new Response('x', { headers: { 'content-length': 'NaN' } }), 'VENDOR_BAD_RESPONSE'],
    [new Response('x', { headers: { 'content-length': '1025' } }), 'VENDOR_RESPONSE_LIMIT'],
    [new Response(new Uint8Array([255])), 'VENDOR_BAD_RESPONSE'],
  ] as const) await assert.rejects(new VendorHttp(async () => response).text(url, {}, options), isCode(code));
  assert.equal(await new VendorHttp(async () => new Response('가')).text(url, {}, { ...options, maxBytes: 3 }), '가');
  await assert.rejects(new VendorHttp(async () => new Response('가')).text(url, {}, { ...options, maxBytes: 2 }), isCode('VENDOR_RESPONSE_LIMIT'));
  await assert.rejects(new VendorHttp(async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } })))
    .text(url, {}, { ...options, timeoutMs: 1000 }), isCode('VENDOR_RESPONSE_LIMIT'));
});

test('HTTP errors and redirects cannot masquerade as success; requests disable cache/redirects', async () => {
  for (const status of [301, 302, 307, 308, 401, 429, 500, 503]) {
    let calls = 0; let cancelled = false;
    const http = new VendorHttp(async (_url, init) => {
      calls++; assert.equal(init?.redirect, 'manual'); assert.equal(init?.cache, 'no-store'); assert.equal(init?.credentials, 'omit');
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: 'https://never-follow.invalid' } });
    });
    await assert.rejects(http.text(url, { method: 'POST' }, options), e => isCode('VENDOR_HTTP')(e) && (e as VendorTransportError).upstreamStatus === status);
    assert.equal(calls, 1); assert.equal(cancelled, true);
  }
});

test('header timeout aborts, retains unsettled fetch slots, and discards late successes', async () => {
  const pending = Array.from({ length: 4 }, () => deferred<Response>()); let calls = 0;
  const signals: AbortSignal[] = [];
  const http = new VendorHttp(async (_url, init) => {
    signals.push(init!.signal!); const n = calls++;
    return n < 4 ? pending[n].promise : new Response('fresh');
  });
  await Promise.all(pending.map(() => assert.rejects(http.text(url, {}, { ...options, timeoutMs: 10 }), isCode('VENDOR_TIMEOUT'))));
  assert.ok(signals.every(s => s.aborted));
  await assert.rejects(http.text(url, {}, options), isCode('VENDOR_CAPACITY')); assert.equal(calls, 4);
  for (const item of pending) item.resolve(new Response('late untrusted success'));
  await delay(5);
  assert.equal(await http.text(url, {}, options), 'fresh');
});

test('body timeout responds despite stalled cancellation but does not release its admission slot', async () => {
  const cancellations = Array.from({ length: 4 }, () => deferred<void>()); let calls = 0;
  const http = new VendorHttp(async () => {
    const n = calls++;
    return n < 4 ? new Response(new ReadableStream({ cancel() { return cancellations[n].promise; } })) : new Response('recovered');
  });
  await Promise.all(cancellations.map(() => assert.rejects(http.text(url, {}, { ...options, timeoutMs: 10 }), isCode('VENDOR_TIMEOUT'))));
  await assert.rejects(http.text(url, {}, options), isCode('VENDOR_CAPACITY'));
  for (const item of cancellations) item.resolve();
  await delay(5); assert.equal(await http.text(url, {}, options), 'recovered');
});

test('network exceptions and malformed options do not expose secrets or dispatch oversized strings', async () => {
  let calls = 0;
  const http = new VendorHttp(async () => { calls++; throw new Error('synthetic secret RRN account token password'); });
  await assert.rejects(http.text(url, {}, options), e => isCode('VENDOR_NETWORK')(e) && !/RRN|password|account|token/.test(String(e)));
  await assert.rejects(http.text(url, { body: 'a'.repeat(VENDOR_HTTP_LIMITS.requestBytes + 1) }, options), isCode('VENDOR_REQUEST_LIMIT'));
  await assert.rejects(http.text(url, {}, { ...options, timeoutMs: Infinity }), /invalid vendor HTTP limits/);
  assert.equal(calls, 1);
  for (const policy of [{ tokenTimeoutMs: 10_001 }, { productTimeoutMs: 30_001 }, { tokenTimeoutMs: NaN }, { productTimeoutMs: 0 }]) {
    assert.throws(() => vendorTimeouts(policy), /invalid vendor timeout policy/);
  }
});

test('native localhost fetch aborts stalled headers/body, bounds decompressed gzip, and never follows a redirect', async t => {
  let destination = 0; const abortedResponses = new Set<string>();
  const server = createServer((req, res) => {
    res.on('close', () => { if (!res.writableEnded) abortedResponses.add(req.url!); });
    if (req.url === '/redirect') { res.writeHead(307, { location: '/destination' }); res.end(); }
    else if (req.url === '/destination') { destination++; res.end('forbidden'); }
    else if (req.url === '/gzip') { const body = gzipSync(Buffer.alloc(4096, 65)); res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': body.length }); res.end(body); }
    else if (req.url === '/body') { res.writeHead(200); res.flushHeaders(); res.write('partial'); }
    // /headers deliberately never replies.
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const http = new VendorHttp();
  for (const path of ['/headers', '/body']) await assert.rejects(http.text(base + path, { method: 'POST' }, { ...options, timeoutMs: 200 }), isCode('VENDOR_TIMEOUT'));
  await assert.rejects(http.text(base + '/gzip', {}, options), isCode('VENDOR_RESPONSE_LIMIT'));
  await assert.rejects(http.text(base + '/redirect', { method: 'POST', body: 'synthetic-only' }, options), isCode('VENDOR_HTTP'));
  await delay(20); assert.equal(destination, 0); assert.deepEqual([...abortedResponses].sort(), ['/body', '/headers']);
});

test('token cache is single-flight, bounds expiry/value and protects a newer token against old invalidation', async () => {
  const cache = new VendorTokenCache(() => 1000, 3600); let calls = 0; const first = deferred<Record<string, unknown>>();
  const load = () => { calls++; return first.promise; };
  const all = Array.from({ length: 20 }, () => cache.get(load)); first.resolve({ access_token: 'token-one', expires_in: '3600' });
  assert.deepEqual(await Promise.all(all), Array(20).fill('token-one')); assert.equal(calls, 1);
  cache.invalidate('token-one'); await cache.get(async () => ({ access_token: 'token-two', expires_in: 3600 }));
  cache.invalidate('token-one'); assert.equal(await cache.get(async () => { throw new Error('must stay cached'); }), 'token-two');
  for (const malformed of [{ access_token: {} }, { access_token: 'secret\r\nheader' }, { access_token: 'ok', expires_in: -1 },
    { access_token: 'ok', expires_in: 'Infinity' }, { access_token: 'ok', expires_in: 3601 }]) {
    await assert.rejects(cache.get(async () => malformed, true), isCode('VENDOR_BAD_RESPONSE'));
  }
  assert.equal(await cache.get(async () => ({ access_token: 'recovered', expires_in: 3600 })), 'recovered');
});

function vendorPair(f: typeof fetch) {
  return [new CodefBankAccountVendor(new CodefClient({ clientId: 'synthetic', clientSecret: 'synthetic', env: 'api', fetch: f, productTimeoutMs: 10 })),
    new OpenBankingAccountVendor({ clientId: 'synthetic', clientSecret: 'synthetic', clientUseCode: 'M202300440', cntrAccountNum: 'synthetic', wdPassPhrase: 'synthetic', env: 'test', fetch: f, productTimeoutMs: 10 })];
}

test('both actual bank connectors never replay one-won POSTs on 401, 500, invalid JSON or timeout', async () => {
  for (const failure of ['401', '500', 'json', 'timeout']) {
    let tokens = 0; let products = 0;
    const f: typeof fetch = async (url, init) => {
      if (String(url).includes('oauth')) { tokens++; return Response.json({ access_token: 'synthetic-token', expires_in: 3600 }); }
      products++; assert.equal(init?.redirect, 'manual');
      if (failure === 'timeout') return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      return new Response(failure === 'json' ? '<invalid>' : '{}', { status: failure === '401' ? 401 : failure === '500' ? 500 : 200 });
    };
    for (const vendor of vendorPair(f)) {
      await assert.rejects(vendor.oneWonTransfer({ bankCode: '004', accountNumber: '1234567890', holderName: 'Synthetic' }), e => e instanceof VendorTransportError);
    }
    assert.equal(tokens, 2); assert.equal(products, 2, `one POST per connector: ${failure}`);
  }
});

test('both OAuth clients collapse concurrent refresh, fail closed on bad token and never start a product after token timeout', async () => {
  for (const kind of ['codef', 'openbanking']) {
    let calls = 0; let badToken = false;
    const f: typeof fetch = async (url, init) => {
      calls++; assert.ok(String(url).includes('oauth'), 'no product may be dispatched without a valid token');
      if (badToken) return Response.json({ access_token: {}, expires_in: 3600 });
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic timeout'))));
    };
    const cl = kind === 'codef' ? new CodefClient({ clientId: 'x', clientSecret: 'x', env: 'sandbox', fetch: f, tokenTimeoutMs: 10 })
      : new OpenBankingAccountVendor({ clientId: 'x', clientSecret: 'x', clientUseCode: 'M202300440', cntrAccountNum: 'x', wdPassPhrase: 'x', env: 'test', fetch: f, tokenTimeoutMs: 10 });
    await Promise.all(Array.from({ length: 20 }, () => assert.rejects(cl.accessToken(), isCode('VENDOR_TIMEOUT'))));
    assert.equal(calls, 1);
    const product = () => cl instanceof CodefClient ? cl.request('/v1/test', {})
      : cl.oneWonTransfer({ bankCode: '004', accountNumber: '1234567890', holderName: 'Synthetic' });
    await assert.rejects(product(), isCode('VENDOR_TIMEOUT')); assert.equal(calls, 2);
    badToken = true;
    await assert.rejects(product(), isCode('VENDOR_BAD_RESPONSE')); assert.equal(calls, 3);
  }
});

test('non-2xx success-shaped envelopes and malformed top-level arrays are rejected by both connectors', async () => {
  for (const status of [200, 500]) {
    const f: typeof fetch = async url => String(url).includes('oauth') ? Response.json({ access_token: 'synthetic', expires_in: 3600 })
      : Response.json(status === 200 ? [] : { result: { code: 'CF-00000', message: '' }, data: { authCode: '1234' }, rsp_code: 'A0000', rsp_message: '', res_list: [{ bank_rsp_code: '000' }] }, { status });
    for (const vendor of vendorPair(f)) await assert.rejects(vendor.oneWonTransfer({ bankCode: '004', accountNumber: '1234567890', holderName: 'Synthetic' }), e => e instanceof VendorTransportError);
  }
});
