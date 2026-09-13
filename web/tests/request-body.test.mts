import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BODY_LIMITS, readBoundedBody, readBoundedForm, readJsonObject } from '../lib/request-body';
import { RequestGuardError } from '../lib/request-guard';

// Malformed body route tests must not read live credentials, call vendors, or contact a chain.
for (const name of Object.keys(process.env)) if (/^(CODEF_|OPENBANKING_|ISSUANCE_JOURNAL_|ISSUER_PRIVATE_KEY|ISSUER_KEY_EPOCH|ROTATING_ISSUER_ADDRESS|EVIDENCE_VAULT_|BANK_STATE_)/.test(name)) delete process.env[name];
globalThis.fetch = async () => { throw new Error('unexpected external request in body-limit test'); };
const routes = [
  ['wallet', '/api/kyc/wallet', (await import('../app/api/kyc/wallet/route')).POST],
  ['bank', '/api/kyc/bank', (await import('../app/api/kyc/bank/route')).POST],
  ['issue', '/api/kyc/issue', (await import('../app/api/kyc/issue/route')).POST],
  ['screen', '/api/screen', (await import('../app/api/screen/route')).POST],
  ['id', '/api/kyc/id', (await import('../app/api/kyc/id/route')).POST],
] as const;
const isStatus = (status: number) => (e: unknown) => e instanceof RequestGuardError && e.status === status;
const encoder = new TextEncoder();
function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}, path = '/test') {
  let reads = 0; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { if (reads < chunks.length) controller.enqueue(chunks[reads++]); else controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const request = new Request('http://localhost' + path, { method: 'POST', headers: { 'content-type': 'application/json',
    origin: 'http://localhost', 'x-forwarded-for': randomUUID(), ...headers }, body, duplex: 'half' } as RequestInit);
  return { request, reads: () => reads, cancelled: () => cancelled };
}

test('actual byte limit works without length and with a false smaller length, cancels before trailing data', async () => {
  for (const headers of [{}, { 'content-length': '1' }] as Record<string, string>[]) {
    const f = streamRequest([new Uint8Array(4), new Uint8Array(5), new Uint8Array(100)], headers);
    await assert.rejects(readBoundedBody(f.request, 8), isStatus(413));
    assert.equal(f.reads(), 2); assert.equal(f.cancelled(), true);
  }
});

test('exact byte boundary accepts multibyte JSON across tiny chunks; one less byte rejects', async () => {
  const bytes = encoder.encode('{"name":"가"}');
  const chunks = [...bytes].map(byte => Uint8Array.of(byte));
  assert.deepEqual(await readJsonObject(streamRequest(chunks).request, bytes.length), { name: '가' });
  await assert.rejects(readJsonObject(streamRequest(chunks).request, bytes.length - 1), isStatus(413));
});

test('invalid length, declared oversize, compressed bodies and truncated length fail closed', async () => {
  for (const length of ['-1', 'NaN', 'Infinity', '3.5', '1,2', '9007199254740992']) {
    const f = streamRequest([encoder.encode('{}')], { 'content-length': length });
    await assert.rejects(readBoundedBody(f.request, 8), isStatus(400)); assert.equal(f.reads(), 0);
  }
  await assert.rejects(readBoundedBody(streamRequest([], { 'content-length': '9' }).request, 8), isStatus(413));
  await assert.rejects(readBoundedBody(streamRequest([], { 'content-encoding': 'gzip' }).request, 8), isStatus(415));
  await assert.rejects(readBoundedBody(streamRequest([encoder.encode('{}')], { 'content-length': '4' }).request, 8), isStatus(400));
});

test('JSON requires object, valid UTF-8 and explicit media type', async () => {
  for (const body of ['null', '[]', '123', '"text"', '{']) await assert.rejects(readJsonObject(streamRequest([encoder.encode(body)]).request, 100), isStatus(400));
  await assert.rejects(readJsonObject(streamRequest([Uint8Array.of(0xff)]).request, 100), isStatus(400));
  await assert.rejects(readJsonObject(streamRequest([], { 'content-type': 'text/plain' }).request, 100), isStatus(415));
});

test('deadline returns even when a stalled stream never completes cancellation', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull() {}, cancel() { cancelled = true; return new Promise(() => {}); } });
  const request = new Request('http://localhost/test', { method: 'POST', body, duplex: 'half' } as RequestInit);
  await assert.rejects(readBoundedBody(request, 100, 10), isStatus(408)); assert.equal(cancelled, true);
});

test('abort and stream failure are safe client errors; pathological empty chunks terminate', async () => {
  const controller = new AbortController();
  const request = new Request('http://localhost/test', { method: 'POST', signal: controller.signal,
    body: new ReadableStream({ pull() {} }), duplex: 'half' } as RequestInit);
  const pending = readBoundedBody(request, 100); controller.abort(); await assert.rejects(pending, isStatus(400));
  const broken = new Request('http://localhost/test', { method: 'POST', body: new ReadableStream({ pull(c) { c.error(new Error('private upstream details')); } }), duplex: 'half' } as RequestInit);
  await assert.rejects(readBoundedBody(broken, 100), e => isStatus(400)(e) && !(e as Error).message.includes('private'));
  const empty = new Request('http://localhost/test', { method: 'POST', body: new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(0)); } }), duplex: 'half' } as RequestInit);
  await assert.rejects(readBoundedBody(empty, 100), isStatus(413));
});

test('bounded multipart keeps image bytes and refuses malformed or duplicate fields', async () => {
  const form = new FormData(); form.set('action', 'ocr'); form.set('image', new File([Uint8Array.of(1, 2, 3)], 'synthetic.png', { type: 'image/png' }));
  const make = () => new Request('http://localhost/test', { method: 'POST', body: form });
  const parsed = await readBoundedForm(make(), 4096); assert.equal(parsed.get('action'), 'ocr');
  assert.deepEqual(new Uint8Array(await (parsed.get('image') as File).arrayBuffer()), Uint8Array.of(1, 2, 3));
  // Incoming HTTP bodies are bytes, not Undici's outgoing FormData encoder. Serialize this
  // oversized fixture first so cancellation exercises intake, not that encoder's async enqueue.
  const encoded = make(); const bytes = new Uint8Array(await encoded.arrayBuffer());
  await assert.rejects(readBoundedForm(streamRequest([bytes], { 'content-type': encoded.headers.get('content-type')! }).request, 4), isStatus(413));
  form.append('action', 'verify'); await assert.rejects(readBoundedForm(make(), 4096), isStatus(400));
  await assert.rejects(readBoundedForm(streamRequest([encoder.encode('garbage')], { 'content-type': 'multipart/form-data' }).request, 100), isStatus(400));
});

for (const [name, path, post] of routes) test(`${path} rejects unannounced/understated streamed oversize before auth, vendors or signing`, async () => {
  const type = name === 'id' ? 'multipart/form-data; boundary=synthetic' : 'application/json';
  for (const headers of [{}, { 'content-length': '2' }] as Record<string, string>[]) {
    const f = streamRequest([new Uint8Array(BODY_LIMITS[name]), Uint8Array.of(1), new Uint8Array(100)], { 'content-type': type, ...headers }, path);
    const response = await post(f.request); assert.equal(response.status, 413, JSON.stringify(await response.json()));
    assert.equal(f.cancelled(), true); assert.equal(f.reads(), 2);
  }
  const malformed = streamRequest([encoder.encode('{')], { 'content-type': type }, path);
  assert.equal((await post(malformed.request)).status, 400);
});

test('onchain polling is throttled before any RPC call, including repeated invalid subjects', async () => {
  process.env.NEXT_PUBLIC_CC3_RPC = 'http://127.0.0.1:1';
  const { GET } = await import('../app/api/onchain/route'); const ip = randomUUID();
  const request = (query: string) => new Request('http://localhost/api/onchain' + query, { headers: { 'x-forwarded-for': ip } });
  for (let i = 0; i < 60; i++) assert.equal((await GET(request('?subject=invalid'))).status, 400);
  const response = await GET(request('')); assert.equal(response.status, 429); assert.ok(Number(response.headers.get('retry-after')) > 0);
});
