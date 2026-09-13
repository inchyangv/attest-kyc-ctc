import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { spawn } from 'node:child_process';
import { WorkerHealth, serveWorkerHealth } from './health.js';
import { probeWorker, validateWorkerSelfReport, workerProbeSettings } from './health-probe.js';

const report = () => {
  let clock = 0; const health = new WorkerHealth(10000, () => clock);
  health.running(); clock = 10; health.scanCompleted(); clock = 20;
  return health.report(2);
};
async function server(t: { after: (f: () => Promise<void>) => void }, handler: RequestListener) {
  const s = createServer(handler);
  await new Promise<void>(resolve => s.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { s.close(() => resolve()); s.closeAllConnections(); }));
  return (s.address() as { port: number }).port;
}
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

test('probe settings require explicit literal port, deadline and scan policy with fixed private errors', () => {
  assert.deepEqual(workerProbeSettings('9001', '1000', '10000'), { port: 9001, timeoutMs: 1000, maxScanAgeMs: 10000 });
  for (const args of [[undefined, '1', '1'], ['0', '1', '1'], ['65536', '1', '1'], ['1', '60001', '1'],
    ['http://PRIVATE/', '1', '1'], ['1', '1e3', '1'], ['1', '0', '1'], ['1', '1', '9007199254740992']]) {
    assert.throws(() => workerProbeSettings(...args as [string, string, string]), /^Error: WORKER_PROBE_SETTINGS_INVALID$/);
  }
});

test('probe validates schema, HTTP/status/phase, counters, age and independent policy rather than trusting status alone', () => {
  const good = report(); assert.deepEqual(validateWorkerSelfReport(good, 200, 10000), good);
  assert.notEqual(validateWorkerSelfReport(good, 200, 10000), good);
  for (const bad of [null, [], { ...good, secret: 'PRIVATE' }, { ...good, version: 2 }, { ...good, phase: 'STOPPING' },
    { ...good, chainLag: 'OK' }, { ...good, maxScanAgeMs: 10001 }, { ...good, completedSourceScans: 0 },
    { ...good, uptimeMs: 1 }, { ...good, inFlight: -1 }, { ...good, lastSourceScanAgeMs: null },
    { ...good, status: 'SOURCE_SCAN_ERROR' }, { ...good, status: 'SOURCE_SCAN_STALE' },
    { ...good, lastSourceScanAgeMs: 10000, uptimeMs: 10000 }]) {
    assert.throws(() => validateWorkerSelfReport(bad, 200, 10000), /^Error: WORKER_PROBE_INVALID_RESPONSE$/);
  }
  assert.throws(() => validateWorkerSelfReport(good, 503, 10000));
  const error = { ...good, status: 'SOURCE_SCAN_ERROR', sourceScanErrors: 1 };
  assert.deepEqual(validateWorkerSelfReport(error, 503, 10000), error);
});

test('independent probe observes actual listener startup, success, failure, stopping and closed port without state files', async t => {
  const health = new WorkerHealth(10000), listener = await serveWorkerHealth(health, 0, () => 2);
  let closed = false; t.after(async () => { if (!closed) await listener.close(); });
  const settings = { port: listener.port, timeoutMs: 1000, maxScanAgeMs: 10000 };
  assert.equal((await probeWorker(settings)).code, 'STARTING');
  health.running(); assert.equal((await probeWorker(settings)).code, 'SOURCE_SCAN_NOT_OBSERVED');
  health.scanCompleted(); const good = await probeWorker(settings);
  assert.equal(good.status, 'LOCAL_SCAN_RECENT'); assert.equal(good.worker?.inFlight, 2);
  assert.equal(good.processIdentity, 'NOT_VERIFIED'); assert.equal(good.chainState, 'NOT_CHECKED');
  health.scanError(); assert.equal((await probeWorker(settings)).status, 'ATTENTION_REQUIRED');
  health.scanCompleted(); health.stopping(); assert.equal((await probeWorker(settings)).code, 'STOPPING');
  await listener.close(); closed = true;
  assert.equal((await probeWorker(settings)).status, 'UNAVAILABLE');
});

test('real HTTP probe rejects redirects, oversized/invalid/private bodies and status/header mismatches without retries', async t => {
  let visits = 0;
  const cases: { status?: number; body: string | Buffer; extra?: Record<string, string> }[] = [
    { status: 302, body: 'PRIVATE', extra: { Location: 'http://PRIVATE.invalid' } },
    { body: 'PRIVATE'.repeat(1000) }, { body: Buffer.from([0xff]) }, { body: '{"secret":"PRIVATE"}' },
    { body: 'not JSON PRIVATE' }, { body: JSON.stringify({ ...report(), privateField: 'PRIVATE' }) },
    { status: 503, body: JSON.stringify(report()) },
    { body: JSON.stringify(report()), extra: { 'Content-Type': 'text/plain' } },
    { body: JSON.stringify(report()), extra: { 'Content-Encoding': 'gzip' } },
    { body: JSON.stringify(report()), extra: { 'Cache-Control': 'public' } },
  ];
  let current = cases[0];
  const port = await server(t, (req, res) => {
    visits++; assert.equal(req.url, '/health'); assert.equal(req.method, 'GET');
    assert.equal(req.headers.host, `127.0.0.1:${port}`); assert.equal(req.headers.authorization, undefined);
    res.writeHead(current.status ?? 200, { ...headers, ...current.extra }); res.end(current.body);
  });
  for (current of cases) {
    const result = await probeWorker({ port, timeoutMs: 1000, maxScanAgeMs: 10000 });
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.worker, undefined);
    assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  }
  assert.equal(visits, cases.length);
});

test('one absolute deadline covers silent headers and unfinished bodies and ignores later output', async t => {
  let mode = 'headers', visits = 0;
  const port = await server(t, (_req, res) => {
    visits++; if (mode === 'body') { res.writeHead(200, headers); res.write('{'); }
  });
  for (mode of ['headers', 'body']) {
    const result = await probeWorker({ port, timeoutMs: 60, maxScanAgeMs: 10000 });
    assert.equal(result.code, 'DEADLINE_EXCEEDED'); assert.equal(result.status, 'UNAVAILABLE');
    assert.ok(result.elapsedMs >= 50 && result.elapsedMs < 1500);
  }
  assert.equal(visits, 2);
});

test('probe accounts for response transit age and snapshots caller settings', async t => {
  let now = 0; const health = new WorkerHealth(100, () => now);
  health.running(); health.scanCompleted(); now = 95;
  const timers: ReturnType<typeof setTimeout>[] = []; t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const port = await server(t, (_req, res) => {
    res.writeHead(200, headers); res.write('');
    timers.push(setTimeout(() => res.end(JSON.stringify(health.report(0))), 25));
  });
  const settings = { port, timeoutMs: 1000, maxScanAgeMs: 100 };
  const pending = probeWorker(settings); settings.maxScanAgeMs = 100000;
  const result = await pending;
  assert.equal(result.status, 'ATTENTION_REQUIRED'); assert.equal(result.code, 'SCAN_AGE_BOUND_EXCEEDED');
});

test('actual probe CLI uses only explicit settings and returns exit 0/1/2 with no signing keys', async t => {
  const health = new WorkerHealth(10000), listener = await serveWorkerHealth(health, 0, () => 0);
  t.after(() => listener.close());
  const run = (args: string[] = [], extra: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'script/probe-worker.ts', ...args], {
      env: { PATH: process.env.PATH, WORKER_HEALTH_PORT: String(listener.port), MONITOR_WORKER_TIMEOUT_MS: '1000',
        WORKER_HEALTH_MAX_SCAN_AGE_MS: '10000', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
  assert.equal((await run()).code, 1); health.running(); health.scanCompleted();
  const good = await run(); assert.equal(good.code, 0); assert.equal(JSON.parse(good.output).status, 'LOCAL_SCAN_RECENT');
  assert.equal((await run([], { WORKER_HEALTH_MAX_SCAN_AGE_MS: '9999' })).code, 2);
  const invalid = await run(['PRIVATE']); assert.equal(invalid.code, 2); assert.equal(invalid.output.trim(), 'WORKER_PROBE_UNAVAILABLE');
});
