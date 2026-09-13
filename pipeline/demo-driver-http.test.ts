import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
// @ts-expect-error Executable Node ESM helper, no TS build step.
import { driverJsonRequest, DriverHttpError } from '../deploy/demo-driver-http.mjs';

const secret = 'SYNTHETIC_PRIVATE_RESPONSE_SENTINEL\u001b[31m\nFAKE PASS';
async function serve(t: TestContext, handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const code = (expected: string) => (e: unknown) => {
  assert.ok(e instanceof DriverHttpError);
  const error = e as Error & { code: string; cause?: unknown };
  assert.equal(error.code, expected); assert.equal(error.message, expected); assert.equal(error.cause, undefined);
  assert.equal(String(error.stack).includes(secret), false); return true;
};

test('driver HTTP bounds announced, streamed and decompressed bodies; accepts exact-size JSON', async t => {
  const body = JSON.stringify({ value: 'x'.repeat(1000) });
  const base = await serve(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/announced') { res.setHeader('content-length', 999999); res.flushHeaders(); return; }
    if (req.url === '/gzip') { res.setHeader('content-encoding', 'gzip'); const zipped = gzipSync(body); res.setHeader('content-length', zipped.length); res.end(zipped); return; }
    if (req.url === '/stream') { res.flushHeaders(); res.write(body.slice(0, 500)); res.end(body.slice(500)); return; }
    res.end(body);
  });
  assert.equal((await driverJsonRequest(base, {}, { maxBytes: Buffer.byteLength(body) })).body.value.length, 1000);
  for (const path of ['/announced', '/stream', '/gzip']) {
    await assert.rejects(driverJsonRequest(base + path, {}, { maxBytes: 256 }), code('DRIVER_RESPONSE_TOO_LARGE'));
  }
  await assert.rejects(driverJsonRequest(base, {}, { maxBytes: 0 }), code('DRIVER_INVALID_LIMIT'));
});

test('driver HTTP rejects non-object JSON, invalid UTF-8, malformed JSON and HTML without reflecting bytes', async t => {
  const bodies: Record<string, string | Buffer> = { '/null': 'null', '/array': '[]', '/scalar': '1', '/broken': secret,
    '/utf8': Buffer.from([123, 34, 120, 34, 58, 34, 0xff, 34, 125]), '/html': secret };
  const base = await serve(t, (req, res) => {
    res.setHeader('content-type', req.url === '/html' ? 'text/html' : 'application/json'); res.end(bodies[req.url!]);
  });
  for (const path of Object.keys(bodies)) await assert.rejects(driverJsonRequest(base + path), code('DRIVER_RESPONSE_INVALID'));
});

test('driver HTTP deadline covers header and body stalls; redirects and network failures never retry', async t => {
  const counts = new Map<string, number>();
  const base = await serve(t, (req, res) => {
    counts.set(req.url!, (counts.get(req.url!) ?? 0) + 1);
    if (req.url === '/header') return;
    if (req.url === '/body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    if (req.url === '/redirect') { res.writeHead(307, { location: '/must-not-follow' }); res.end(); return; }
    if (req.url === '/disconnect') { req.socket.destroy(); return; }
    res.end(secret);
  });
  for (const path of ['/header', '/body']) {
    const start = Date.now();
    await assert.rejects(driverJsonRequest(base + path, {}, { timeoutMs: 100 }), code('DRIVER_REQUEST_TIMEOUT'));
    assert.ok(Date.now() - start < 3000);
  }
  for (const path of ['/redirect', '/disconnect']) await assert.rejects(driverJsonRequest(base + path, { method: 'POST', body: 'fixture' }), code('DRIVER_REQUEST_FAILED'));
  assert.deepEqual(Object.fromEntries(counts), { '/header': 1, '/body': 1, '/redirect': 1, '/disconnect': 1 });
});

test('actual driver subprocess never reflects malicious stage fields, parser bodies or URL errors', async t => {
  let fault = ''; let issueCalls = 0;
  const side = (name: string) => ({ configured: true, demo: true, live: false, vendor: `demo:${name}` });
  const base = await serve(t, async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = new URL(req.url!, 'http://fixture').pathname;
    let body: Record<string, any> = {}, status = 200;
    if (path === '/api/kyc/status') {
      body = { demo: true, sandboxBits: true, id: side('id'), bank: side('bank'), bankState: { configured: true },
        issuer: { configured: true }, issuanceJournal: { configured: true }, tokenKey: { configured: true, mode: 'versioned-dedicated' } };
      if (fault === 'status') body.id.vendor = secret;
      if (fault === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(secret); return; }
      if (fault === 'oversized') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ raw: secret.repeat(10000) })); return; }
    } else if (path === '/api/kyc/wallet') {
      body = req.method === 'GET' ? { message: 'Synthetic local log-boundary test', token: secret } : { walletProof: secret, requestId: '0x' + 'aa'.repeat(32) };
    } else if (path === '/api/kyc/id') {
      const bad = Buffer.concat(chunks).includes('FAKE Person');
      body = bad ? { status: fault === 'denial-id' ? secret : 'rejected', summary: { authentic: false } }
        : { status: 'verified', idProof: secret, summary: { vendor: fault === 'id' ? secret : 'demo:id', live: false } };
    } else if (path === '/api/kyc/bank') {
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.action === 'verify') body = { status: 'verified', bankProof: secret, summary: { vendor: fault === 'bank' ? secret : 'demo:bank', live: false, ref: secret } };
      else if (input.accountNumber.endsWith('99')) { status = 422; body = { code: fault === 'denial-bank' ? secret : 'HOLDER_MISMATCH', error: secret }; }
      else body = { challenge: secret, demoCode: '1234', vendor: 'demo:bank', live: false, holderNameMasked: secret, ref: secret };
    } else if (path === '/api/kyc/issue') {
      issueCalls++;
      if (fault === 'recovery') {
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (input.action === 'issue') { res.destroy(); return; }
        assert.deepEqual(input, { action: 'status', requestId: '0x' + 'aa'.repeat(32), walletProof: secret });
      }
      body = { status: 'ISSUED', requestId: '0x' + 'aa'.repeat(32), assurance: secret, regime: secret, methodsHex: secret, policyPreview: { production: secret, sandbox: secret },
        onchain: { sent: true, txHash: secret, issuer: secret, blockNumber: secret }, error: secret };
    } else { status = 500; body = { error: secret }; }
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  const run = (url: string) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['deploy/verify-demo.mjs', url, '--execute-issuance'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  for (const scenario of ['status', 'malformed', 'oversized', 'id', 'denial-id', 'bank', 'denial-bank', 'issue', 'recovery']) {
    fault = scenario; const before = issueCalls; const result = await run(base);
    assert.equal(result.code, 1, `${scenario}: ${result.output}`);
    assert.doesNotMatch(result.output, /SYNTHETIC_PRIVATE_RESPONSE_SENTINEL|FAKE PASS|\u001b|SyntaxError|TypeError/);
    assert.equal(issueCalls - before, scenario === 'recovery' ? 2 : scenario === 'issue' ? 1 : 0);
    if (scenario === 'recovery') assert.match(result.output, /reconciling the original request via status/);
    if (scenario === 'malformed') assert.match(result.output, /DRIVER_RESPONSE_INVALID/);
    if (scenario === 'oversized') assert.match(result.output, /DRIVER_RESPONSE_TOO_LARGE/);
  }
  const invalid = await run('not-a-url-' + secret);
  assert.equal(invalid.code, 2); assert.equal(invalid.output.trim(), 'invalid base URL');
});
