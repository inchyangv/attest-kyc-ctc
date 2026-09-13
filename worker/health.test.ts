import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { WorkerHealth, serveWorkerHealth, workerHealthSettings } from './health.js';
import { probeWorker } from './health-probe.js';
import { Store } from './store.js';

test('health listener is opt-in and requires an explicit bounded port and positive scan threshold', () => {
  assert.equal(workerHealthSettings(undefined, undefined), undefined);
  assert.equal(workerHealthSettings('', ''), undefined);
  assert.deepEqual(workerHealthSettings('9001', '15000'), { port: 9001, maxScanAgeMs: 15000 });
  for (const [port, age] of [['', '1'], ['1', ''], ['0', '1'], ['65536', '1'], ['1', '-1'], ['1', '1.2'], ['1', '1e3'], ['1', '9007199254740992']]) {
    assert.throws(() => workerHealthSettings(port, age));
  }
});

test('live state distinguishes startup, recent/stale completed scans, error recovery and irreversible stopping', () => {
  let now = 0; const health = new WorkerHealth(1000, () => now);
  assert.equal(health.report(0).status, 'STARTING'); health.running();
  assert.equal(health.report(0).status, 'SOURCE_SCAN_NOT_OBSERVED'); health.scanCompleted();
  now = 999; assert.equal(health.report(2).status, 'LOCAL_SCAN_RECENT');
  now = 1000; assert.equal(health.report(2).status, 'SOURCE_SCAN_STALE');
  health.scanError(); assert.equal(health.report(2).status, 'SOURCE_SCAN_ERROR');
  health.scanCompleted(); const report = health.report(2);
  assert.equal(report.status, 'LOCAL_SCAN_RECENT'); assert.equal(report.sourceScanErrors, 1);
  assert.equal(report.completedSourceScans, 2); assert.equal(report.inFlight, 2);
  assert.equal(report.chainLag, 'NOT_CHECKED'); assert.equal(report.hubDelivery, 'NOT_CHECKED');
  health.stopping(); health.running(); health.scanCompleted(); assert.equal(health.report(0).status, 'STOPPING');
  assert.throws(() => health.report(-1)); now = -1; assert.throws(() => health.report(0));
});

test('actual loopback endpoint has no cache, fixed errors, exact authority/path and no browser/body surface', async t => {
  const health = new WorkerHealth(10000), listener = await serveWorkerHealth(health, 0, () => 0);
  t.after(() => listener.close()); const url = `http://127.0.0.1:${listener.port}/health`;
  const startup = await fetch(url); assert.equal(startup.status, 503);
  assert.equal(startup.headers.get('cache-control'), 'no-store'); await startup.body?.cancel();
  health.running(); health.scanCompleted(); const live = await fetch(url);
  assert.equal(live.status, 200); assert.equal((await live.json()).eventLoop, 'RESPONDING');
  for (const [path, method, headers] of [
    ['/health?secret=PRIVATE', 'GET', {}], ['/admin', 'GET', {}], ['/health', 'POST', {}],
    ['/health', 'GET', { Origin: 'https://private.example' }], ['/health', 'GET', { Host: `private.example:${listener.port}` }],
    ['/health', 'GET', { 'Content-Length': '1' }],
  ] as [string, string, Record<string, string>][]) {
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: listener.port, path, method, headers }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode!, body }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(response.status, 404); assert.equal(response.body, '{"error":"NOT_FOUND"}');
  }
  health.stopping(); const stopped = await fetch(url); assert.equal(stopped.status, 503); await stopped.body?.cancel();
});

test('listener reports internal failure privately and an occupied port cannot silently disable health', async t => {
  const listener = await serveWorkerHealth(new WorkerHealth(1000), 0, () => { throw new Error('PRIVATE-ERROR'); });
  t.after(() => listener.close()); const response = await fetch(`http://127.0.0.1:${listener.port}/health`);
  assert.equal(response.status, 503); assert.equal(await response.text(), '{"error":"WORKER_HEALTH_UNAVAILABLE"}');
  await assert.rejects(serveWorkerHealth(new WorkerHealth(1000), listener.port, () => 0));
});

test('real worker subprocess exposes live scans, paused-process timeout, RPC failure/recovery and clean shutdown', { timeout: 20000 }, async t => {
  const source = '0x' + '11'.repeat(20), asc = '0x' + '22'.repeat(20);
  const abi = new ethers.Interface(['function TRANSACTION_PROCESSING_VERSION() view returns(uint256)',
    'function EPOCH_SCHEMA_VERSION() view returns(uint256)', 'function ROSTER_AUTH_VERSION() view returns(uint256)',
    'function ISSUER_KEY_PROVENANCE_VERSION() view returns(uint256)',
    'function DENIAL_CORRECTION_VERSION() view returns(uint256)',
    'function expectedChainKey() view returns(uint64)', 'function sourceContract() view returns(address)']);
  let failed = false, stalled = false, work = false, proofCalls = 0;
  const sourceTxHash = ethers.id('synthetic-stop-job');
  let proofStarted!: () => void; const proofRequest = new Promise<void>(resolve => proofStarted = resolve);
  const pending: (() => void)[] = [], unexpected: string[] = [];
  const rpc = createServer(async (req, res) => {
    if (req.url === '/unused-proof/api/v1/attested-height/1') {
      proofCalls++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{"attestedHeight":');
      proofStarted(); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    if (stalled && req.url === '/source' && (Array.isArray(input) ? input : [input]).some(call => call.method === 'eth_blockNumber')) {
      await new Promise<void>(resolve => pending.push(resolve));
    }
    const answer = (call: { id: number; method: string; params: any[] }) => {
      let result: unknown;
      if (failed && req.url === '/source' && call.method === 'eth_blockNumber') {
        return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'PRIVATE-RPC-FAULT' } };
      }
      switch (call.method) {
        case 'eth_chainId': result = ethers.toQuantity(req.url === '/source' ? 11155111 : 102031); break;
        case 'eth_call': {
          const fn = abi.parseTransaction({ data: call.params[0].data })!.name;
          result = abi.encodeFunctionResult(fn, [fn === 'sourceContract' ? source
            : ['ROSTER_AUTH_VERSION', 'ISSUER_KEY_PROVENANCE_VERSION', 'DENIAL_CORRECTION_VERSION', 'expectedChainKey'].includes(fn) ? 1 : 2]); break;
        }
        case 'eth_getTransactionCount': result = '0x0'; break;
        case 'eth_blockNumber': result = work ? '0x15' : '0x14'; break;
        case 'eth_getLogs': {
          const event = new ethers.Interface(['event MarkRevoked(address indexed subject, uint16 indexed reasonCode, uint32 indexed epoch)']);
          result = work ? [{ ...event.encodeEventLog(event.getEvent('MarkRevoked')!, [source, 2, 1]), address: source,
            blockHash: ethers.id('block-20'), blockNumber: '0x14', transactionHash: sourceTxHash, transactionIndex: '0x0', logIndex: '0x0', removed: false }] : [];
          break;
        }
        case 'eth_getBlockByNumber': {
          const number = call.params[0] === 'finalized' ? work ? 21 : 20 : Number(call.params[0]);
          result = { number: ethers.toQuantity(number), hash: ethers.id(`block-${number}`), parentHash: ethers.id(`block-${number - 1}`),
            timestamp: ethers.toQuantity(Math.floor(Date.now() / 1000)), nonce: '0x0000000000000000', difficulty: '0x0',
            gasLimit: '0x1c9c380', gasUsed: '0x0', miner: source, extraData: '0x', transactions: [] }; break;
        }
        default: unexpected.push(call.method); return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'UNEXPECTED_METHOD' } };
      }
      return { jsonrpc: '2.0', id: call.id, result };
    };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)));
  });
  await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
  const rpcPort = (rpc.address() as { port: number }).port;
  t.after(() => new Promise<void>(resolve => { rpc.close(() => resolve()); rpc.closeAllConnections(); }));
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const healthPort = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-live-worker-')), path = join(dir, 'worker.json');
  const key = ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').privateKey;
  const initial = new Store(path); initial.bindScope({ sourceChainId: 11155111, hubChainId: 102031, chainKey: 1,
    source, asc, signer: new ethers.Wallet(key).address.toLowerCase(), startBlock: 10 }); initial.initializeHubSigner(0);
  const child = spawn(process.execPath, ['--import', 'tsx', 'worker/index.ts'], { cwd: process.cwd(),
    env: { PATH: process.env.PATH, SOURCE_CHAIN_RPC_URL: `http://127.0.0.1:${rpcPort}/source`, CREDITCOIN_RPC_URL: `http://127.0.0.1:${rpcPort}/hub`,
      PROOF_BUILDER_URL: `http://127.0.0.1:${rpcPort}/unused-proof`, WORKER_PRIVATE_KEY: key,
      WORKER_SIGNER_ADDRESS: new ethers.Wallet(key).address, SOURCE_CONTRACT_ADDRESS: source,
      ASC_CONTRACT_ADDRESS: asc, SOURCE_CHAIN_KEY: '1', WORKER_START_BLOCK: '10', WORKER_CONFIRMATIONS: '1',
      WORKER_POLL_MS: '50', WORKER_STATE_PATH: path, WORKER_HEALTH_PORT: String(healthPort), WORKER_HEALTH_MAX_SCAN_AGE_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => output = (output + data).slice(-6000)); child.stderr.on('data', data => output = (output + data).slice(-6000));
  const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => {
    stalled = false; for (const resolve of pending.splice(0)) resolve();
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGCONT'); child.kill('SIGKILL'); }
    await exit; rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${healthPort}/health`;
  const until = async (status: string) => {
    for (let n = 0; n < 100; n++) {
      assert.equal(child.exitCode, null, output);
      try { const res = await fetch(url, { signal: AbortSignal.timeout(300) }), body = await res.json();
        if (body.status === status) return { res, body };
      } catch { /* listener/scan is not ready yet */ }
      await delay(30);
    }
    throw new Error(`worker did not report ${status}: ${output}`);
  };
  const live = await until('LOCAL_SCAN_RECENT'); assert.equal(live.res.status, 200);
  const probeSettings = { port: healthPort, timeoutMs: 150, maxScanAgeMs: 1000 };
  assert.equal((await probeWorker(probeSettings)).status, 'LOCAL_SCAN_RECENT');
  assert.ok(live.body.completedSourceScans > 0); assert.equal(live.body.hubDelivery, 'NOT_CHECKED');
  const bytes = readFileSync(path); assert.equal(JSON.parse(bytes.toString()).cursor, 19);
  child.kill('SIGSTOP'); await delay(100);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(150) }));
  assert.equal((await probeWorker(probeSettings)).code, 'DEADLINE_EXCEEDED');
  assert.deepEqual(readFileSync(path), bytes, 'a recent file remains during a frozen process');
  child.kill('SIGCONT'); await until('LOCAL_SCAN_RECENT');
  stalled = true; const stale = await until('SOURCE_SCAN_STALE');
  assert.equal(stale.res.status, 503); assert.equal(stale.body.eventLoop, 'RESPONDING');
  assert.ok(pending.length > 0, 'RPC read really is outstanding while health still responds');
  assert.equal((await probeWorker(probeSettings)).code, 'SOURCE_SCAN_STALE');
  stalled = false; for (const resolve of pending.splice(0)) resolve(); await until('LOCAL_SCAN_RECENT');
  failed = true; const failure = await until('SOURCE_SCAN_ERROR'); assert.equal(failure.res.status, 503);
  assert.equal(JSON.stringify(failure.body).includes('PRIVATE-'), false);
  failed = false; await until('LOCAL_SCAN_RECENT');
  work = true; await proofRequest;
  const beforeStop = JSON.parse(readFileSync(path, 'utf8')); assert.equal(beforeStop.jobs[sourceTxHash].state, 'discovered');
  const stopAt = performance.now(); child.kill('SIGTERM'); assert.deepEqual(await exit, { code: 0, signal: null });
  assert.ok(performance.now() - stopAt < 2000, 'shutdown cancels active attestation body instead of waiting 15 seconds');
  const stoppedState = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(stoppedState.jobs[sourceTxHash], beforeStop.jobs[sourceTxHash]);
  assert.equal(stoppedState.relay, undefined); assert.equal(proofCalls, 1);
  assert.equal(existsSync(`${path}.lock`), false);
  assert.equal(existsSync(join(dir, `relay-102031-${new ethers.Wallet(key).address.toLowerCase()}.lock`)), false);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(300) })); assert.deepEqual(unexpected, []);
});
