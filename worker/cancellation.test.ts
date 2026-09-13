import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { proofProvider } from '@gluwa/usc-sdk';
import { sleep, withRetry, Backoff, WorkerStoppedError } from './retry.js';
import { proofJson } from './proof-http.js';
import { fetchProof } from './proof.js';
import { AttestationWatcher } from './attestation.js';

async function server(t: { after: (fn: () => Promise<void>) => void }, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler); await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { http.close(() => resolve()); http.closeAllConnections(); }));
  return `http://127.0.0.1:${(http.address() as { port: number }).port}`;
}

test('poll/backoff sleeps abort promptly, pre-aborted work never runs and late success is not accepted', async () => {
  const ctl = new AbortController(); const waiting = sleep(60000, ctl.signal); ctl.abort('PRIVATE-REASON');
  await assert.rejects(waiting, WorkerStoppedError); let calls = 0;
  await assert.rejects(withRetry('test', async () => { calls++; }, { signal: ctl.signal }), WorkerStoppedError);
  assert.equal(calls, 0);
  const later = new AbortController();
  await assert.rejects(withRetry('test', async () => { later.abort(); return 'late success'; }, { signal: later.signal }), WorkerStoppedError);
  const retry = new AbortController(); let attempted!: () => void; const first = new Promise<void>(resolve => attempted = resolve);
  const result = withRetry('synthetic', async () => { calls++; attempted(); throw new Error('SYNTHETIC_RETRY'); },
    { signal: retry.signal, backoff: new Backoff(60000, 60000) });
  await first; await delay(10); retry.abort(); await assert.rejects(result, WorkerStoppedError); assert.equal(calls, 1);
});

test('native proof HTTP abort closes both stalled-header and stalled-body requests, without another attempt', async t => {
  for (const bodyStarted of [false, true]) {
    let requested!: () => void, closed!: () => void, calls = 0;
    const seen = new Promise<void>(resolve => requested = resolve), ended = new Promise<void>(resolve => closed = resolve);
    const url = await server(t, (_req, res) => { calls++; res.on('close', closed);
      if (bodyStarted) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"pending":'); }
      requested();
    });
    const ctl = new AbortController(), promise = proofJson(url, { signal: ctl.signal, timeoutMs: 15000, maxBytes: 1024 });
    await seen; ctl.abort('PRIVATE-REASON'); await assert.rejects(promise, WorkerStoppedError);
    await Promise.race([ended, delay(1000).then(() => { throw new Error('HTTP request was not closed'); })]);
    assert.equal(calls, 1);
  }
});

test('proof HTTP deadlines, redirect/status rejection and decoded byte/UTF-8/JSON bounds use fixed diagnostics', async t => {
  let path = '/stall'; const url = await server(t, (req, res) => {
    switch (req.url) {
      case '/stall': res.writeHead(200); res.write('{'); break;
      case '/redirect': res.writeHead(302, { Location: '/PRIVATE-target' }); res.end(); break;
      case '/error': res.writeHead(500); res.end('PRIVATE-ERROR'); break;
      case '/gzip': res.writeHead(200, { 'Content-Encoding': 'gzip' }); res.end(gzipSync(' '.repeat(5000))); break;
      case '/utf8': res.end(Buffer.from([0x22, 0xff, 0x22])); break;
      case '/json': res.end('PRIVATE-NON-JSON'); break;
      default: assert.fail('redirect must not be followed');
    }
  });
  for (const [target, code] of [['/stall', 'PROOF_HTTP_TIMEOUT'], ['/redirect', 'PROOF_HTTP_NETWORK'], ['/error', 'PROOF_HTTP_STATUS'],
    ['/gzip', 'PROOF_HTTP_LIMIT'], ['/utf8', 'PROOF_HTTP_INVALID'], ['/json', 'PROOF_HTTP_INVALID']]) {
    path = target; await assert.rejects(proofJson(url + path, { timeoutMs: 100, maxBytes: 1024 }), { message: code });
  }
});

test('proof retrieval keeps pinned SDK GET/raw-JSON mapping and cancellation stops an active proof request', async t => {
  const hash = '0x' + 'ab'.repeat(32), routes: string[] = [];
  const fixture = { chainKey: 1, headerNumber: 10, txBytes: '0x1234', merkleProof: { root: hash, siblings: [] },
    continuityProof: { lowerEndpointDigest: hash, roots: [hash] } };
  let stall = false, requested!: () => void; const seen = new Promise<void>(resolve => requested = resolve);
  const url = await server(t, (req, res) => { routes.push(req.url!);
    if (stall) { requested(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(fixture));
  });
  const sdk = await new proofProvider.service.ProofBuilder(1, url).getProof(hash);
  assert.equal(sdk.success, true); assert.deepEqual(await fetchProof(url, 1, hash), sdk.data);
  assert.deepEqual(routes, [`/api/v1/proof-by-tx/1/${hash}`, `/api/v1/proof-by-tx/1/${hash}`]);
  stall = true; const ctl = new AbortController(), pending = fetchProof(url, 1, hash, ctl.signal);
  await seen; ctl.abort(); await assert.rejects(pending, WorkerStoppedError); assert.equal(routes.length, 3);
});

test('attestation active HTTP and below-height poll both cancel without another retry/poll', async t => {
  for (const stalled of [true, false]) {
    let calls = 0, requested!: () => void; const seen = new Promise<void>(resolve => requested = resolve);
    const url = await server(t, (_req, res) => { calls++; requested();
      if (!stalled) { res.setHeader('Content-Type', 'application/json'); res.end('{"attestedHeight":1}'); }
    });
    const ctl = new AbortController(), pending = new AttestationWatcher(url, 1, 60000).waitFor(100, ctl.signal);
    await seen; await delay(20); ctl.abort(); await assert.rejects(pending, WorkerStoppedError); assert.equal(calls, 1);
  }
});
