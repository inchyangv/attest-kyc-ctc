import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
// @ts-expect-error Executable ESM helper has no TS build step.
import { reconcileDriverIssuance } from '../deploy/demo-driver-issuance.mjs';

const requestId = '0x' + '11'.repeat(32), otherId = '0x' + '22'.repeat(32);
const payload = { walletProof: 'synthetic-wallet-proof', idProof: 'synthetic-id-proof', bankProof: 'synthetic-bank-proof', declared: { fullName: 'FICTIONAL PERSON' } };
const options = { pollMs: 1, timeoutMs: 2000 };
type Body = Record<string, unknown>;
async function endpoint(t: TestContext, handler: (body: Body, res: ServerResponse, n: number) => void) {
  const calls: Body[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body); handler(body, res, calls.length);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls };
}
function reply(res: ServerResponse, body: Body, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
function originalOnly(calls: Body[]) {
  assert.equal(calls.filter(c => c.action === 'issue').length, 1);
  assert.deepEqual(calls[0], { ...payload, action: 'issue' });
  for (const body of calls.slice(1)) assert.deepEqual(Object.keys(body).sort(), ['action', 'requestId', 'walletProof']);
  assert.ok(calls.slice(1).every(c => c.requestId === requestId && c.walletProof === payload.walletProof && ['status', 'resume'].includes(String(c.action))));
}

test('driver reconciles a lost initial response and resumable 503 by status, without sending identity again', async t => {
  const h = await endpoint(t, (_body, res, n) => {
    if (n === 1) { res.destroy(); return; }
    if (n === 3) { reply(res, { requestId, resumable: true }, 503); return; }
    reply(res, { requestId, status: n === 5 ? 'ISSUED' : 'PREPARED' });
  });
  assert.equal((await reconcileDriverIssuance(h.url, requestId, payload, options)).body.status, 'ISSUED');
  assert.deepEqual(h.calls.map(c => c.action), ['issue', 'status', 'resume', 'status', 'resume']); originalOnly(h.calls);
});

test('driver checks status after an ambiguous resume and accepts the original committed result', async t => {
  const h = await endpoint(t, (_body, res, n) => {
    if (n === 2) { res.destroy(); return; }
    reply(res, { requestId, status: n === 1 ? 'PREPARED' : 'ISSUED' });
  });
  const result = await reconcileDriverIssuance(h.url, requestId, payload, options);
  assert.equal(result.body.status, 'ISSUED'); assert.deepEqual(h.calls.map(c => c.action), ['issue', 'resume', 'status']); originalOnly(h.calls);
});

test('driver refuses request substitution, unknown requests, auth failures, malformed bodies and confirmed reverts', async t => {
  for (const variant of ['different-id', 'missing-id', 'not-found', 'auth', 'failed', 'denied', 'plain503', 'malformed']) {
    const h = await endpoint(t, (_body, res, n) => {
      if (n === 1) { reply(res, { requestId, resumable: true }, 409); return; }
      if (variant === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('PRIVATE_BAD_JSON'); return; }
      if (variant === 'not-found' || variant === 'auth' || variant === 'plain503') { reply(res, { requestId }, variant === 'not-found' ? 404 : variant === 'auth' ? 400 : 503); return; }
      reply(res, { ...(variant === 'missing-id' ? {} : { requestId: variant === 'different-id' ? otherId : requestId }),
        status: variant === 'failed' ? 'FAILED' : variant === 'denied' ? 'DENIED' : 'PREPARED', issuance: { lastError: 'SOURCE_REVERTED' } });
    });
    if (['different-id', 'missing-id', 'malformed'].includes(variant)) {
      await assert.rejects(reconcileDriverIssuance(h.url, requestId, payload, options), new RegExp(variant === 'malformed' ? 'DRIVER_RESPONSE_INVALID' : 'DRIVER_REQUEST_ID_MISMATCH'));
    } else {
      const result = await reconcileDriverIssuance(h.url, requestId, payload, options);
      assert.notEqual(result.body.status, 'ISSUED');
    }
    assert.deepEqual(h.calls.map(c => c.action), ['issue', 'status']); originalOnly(h.calls);
  }
});

test('driver reconciliation has one overall header/body/poll deadline and never begins a second issuance', async t => {
  for (const variant of ['headers', 'body', 'busy']) {
    const h = await endpoint(t, (_body, res) => {
      if (variant === 'headers') return;
      if (variant === 'body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
      reply(res, { requestId, resumable: true }, 503);
    });
    const start = performance.now();
    await assert.rejects(reconcileDriverIssuance(h.url, requestId, payload, { timeoutMs: 120, pollMs: 10 }), /DRIVER_ISSUANCE_DEADLINE/);
    assert.ok(performance.now() - start < 2000); originalOnly(h.calls);
  }
  await assert.rejects(reconcileDriverIssuance('http://127.0.0.1:1', 'invalid', payload, options), /DRIVER_INVALID_ISSUANCE_CONFIG/);
});
