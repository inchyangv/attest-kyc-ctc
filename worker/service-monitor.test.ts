import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';
import { WorkerHealth, serveWorkerHealth } from './health.js';
import { probeWorkerService, workerServiceMonitorSettings, type WorkerServiceMonitorSettings } from './service-monitor.js';
import type { WorkerScope } from './store.js';

const NOW = Date.now();
const scope: WorkerScope = { sourceChainId: 11155111, hubChainId: 102031, chainKey: 1, startBlock: 10,
  source: '0x' + '11'.repeat(20), asc: '0x' + '22'.repeat(20), signer: '0x' + '33'.repeat(20) };

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function rpcServer(t: { after: (fn: () => Promise<void>) => void }, chainId: number,
  values: { head: number; timestamp?: number; latestNonce?: number; pendingNonce?: number; balance?: bigint; gas?: bigint },
  visits: string[] = []) {
  const server = createServer(async (request, response) => {
    const call = await body(request); const method = String(call.method); visits.push(method);
    const params = call.params as string[];
    const result = method === 'eth_chainId' ? ethers.toQuantity(chainId)
      : method === 'eth_getBlockByNumber' ? { number: ethers.toQuantity(values.head), timestamp: ethers.toQuantity(Math.floor(values.timestamp ?? NOW / 1000)) }
      : method === 'eth_getTransactionCount' ? ethers.toQuantity(params[1] === 'latest' ? values.latestNonce ?? 5 : values.pendingNonce ?? 5)
      : method === 'eth_getBalance' ? ethers.toQuantity(values.balance ?? ethers.parseEther('1'))
      : method === 'eth_gasPrice' ? ethers.toQuantity(values.gas ?? 10n)
      : null;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }, cursor = 108) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-worker-service-monitor-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'worker.json');
  writeFileSync(statePath, JSON.stringify({ version: 1, scope, cursor, jobs: {}, hubStartNonce: 5,
    sourceCheckpoints: [{ height: 9, hash: ethers.id('anchor') }, { height: cursor, hash: ethers.id(`block-${cursor}`) }] }));
  const health = new WorkerHealth(10_000); health.running(); health.scanCompleted();
  const listener = await serveWorkerHealth(health, 0, () => 0); t.after(() => listener.close());
  const sourceVisits: string[] = [], hubVisits: string[] = [];
  const sourceRpcUrl = await rpcServer(t, scope.sourceChainId, { head: 110 }, sourceVisits);
  const hubRpcUrl = await rpcServer(t, scope.hubChainId, { head: 200 }, hubVisits);
  const settings: WorkerServiceMonitorSettings = { health: { port: listener.port, timeoutMs: 1000, maxScanAgeMs: 10_000 },
    sourceRpcUrl, hubRpcUrl, statePath, scope, stateLimits: { jobAgeMs: 60_000, attempts: 3 },
    thresholds: { sourceMaxBlockLag: 5, sourceMaxHeadAgeSeconds: 30, hubMaxHeadAgeSeconds: 30,
      hubMinBalanceWei: ethers.parseEther('0.1'), hubMaxGasPriceWei: 100n, hubMaxNonceBacklog: 2 } };
  return { settings, statePath, sourceVisits, hubVisits, health };
}

test('PM-T17-01 recent self-report cannot hide a source chain that is 100 blocks ahead', async t => {
  const f = await fixture(t, 10), bytes = readFileSync(f.statePath);
  const result = await probeWorkerService(f.settings, NOW);
  assert.equal(result.status, 'ATTENTION_REQUIRED');
  assert.deepEqual(result.findings, ['SOURCE_CURSOR_LAG']);
  assert.equal(result.chains?.source.lagBlocks, 100);
  assert.deepEqual(f.sourceVisits.sort(), ['eth_chainId', 'eth_getBlockByNumber'].sort());
  assert.deepEqual(f.hubVisits.sort(), ['eth_chainId', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByNumber',
    'eth_getTransactionCount', 'eth_getTransactionCount'].sort());
  assert.deepEqual(readFileSync(f.statePath), bytes);
  assert.equal(result.chainState, 'OBSERVED_FROM_CONFIGURED_RPC_NOT_INDEPENDENTLY_VERIFIED');
  assert.equal(result.alertDelivery, 'NOT_CHECKED');
});

test('inclusive chain, balance, gas and nonce thresholds are independent findings', async t => {
  const f = await fixture(t);
  f.settings.thresholds.sourceMaxBlockLag = 2;
  f.settings.thresholds.sourceMaxHeadAgeSeconds = 1;
  f.settings.thresholds.hubMaxHeadAgeSeconds = 1;
  f.settings.thresholds.hubMinBalanceWei = ethers.parseEther('2');
  f.settings.thresholds.hubMaxGasPriceWei = 10n;
  f.settings.thresholds.hubMaxNonceBacklog = 1;
  f.settings.sourceRpcUrl = await rpcServer(t, scope.sourceChainId, { head: 110, timestamp: NOW / 1000 - 1 });
  f.settings.hubRpcUrl = await rpcServer(t, scope.hubChainId, { head: 200, timestamp: NOW / 1000 - 1,
    latestNonce: 5, pendingNonce: 6, balance: ethers.parseEther('1'), gas: 10n });
  const result = await probeWorkerService(f.settings, NOW);
  assert.deepEqual(result.findings, ['SOURCE_CURSOR_LAG', 'SOURCE_HEAD_STALE', 'HUB_HEAD_STALE',
    'HUB_BALANCE_LOW', 'HUB_GAS_PRICE_HIGH', 'HUB_NONCE_BACKLOG']);
  assert.equal(result.chains?.hub.nonceBacklog, 1);
});

test('quiet composite observation is explicit but does not claim identity, independent RPC or alert delivery', async t => {
  const f = await fixture(t);
  const result = await probeWorkerService(f.settings, NOW);
  assert.equal(result.status, 'SERVICE_OBSERVATIONS_OK'); assert.deepEqual(result.findings, []);
  assert.equal(result.processIdentity, 'NOT_VERIFIED'); assert.equal(result.alertDelivery, 'NOT_CHECKED');
  assert.equal(result.state?.processLiveness, 'NOT_CHECKED');
  assert.equal(JSON.stringify(result).includes(scope.signer), false);
});

test('malformed or mismatched RPC evidence is unavailable with bounded private output', async t => {
  const f = await fixture(t);
  const bad = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'PRIVATE', extra: 'PRIVATE' }));
  });
  await new Promise<void>(resolve => bad.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => bad.close(() => resolve())));
  f.settings.sourceRpcUrl = `http://127.0.0.1:${(bad.address() as { port: number }).port}`;
  const result = await probeWorkerService(f.settings, NOW);
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.code, 'OBSERVATION_UNAVAILABLE');
  assert.equal(result.chains, undefined); assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
});

test('settings reject implicit thresholds, credentials, URL options and invalid scope', () => {
  const valid = { SOURCE_CHAIN_RPC_URL: 'http://127.0.0.1:1', CREDITCOIN_RPC_URL: 'https://rpc.example/path',
    WORKER_HEALTH_PORT: '9001', MONITOR_WORKER_SERVICE_TIMEOUT_MS: '1000', WORKER_HEALTH_MAX_SCAN_AGE_MS: '10000',
    WORKER_STATE_PATH: '/tmp/not-read-here', SOURCE_CHAIN_ID: String(scope.sourceChainId), MONITOR_WORKER_HUB_CHAIN_ID: String(scope.hubChainId),
    SOURCE_CHAIN_KEY: '1', WORKER_START_BLOCK: '10', SOURCE_CONTRACT_ADDRESS: scope.source, ASC_CONTRACT_ADDRESS: scope.asc,
    MONITOR_WORKER_SIGNER_ADDRESS: scope.signer, MONITOR_WORKER_JOB_SECONDS: '60', MONITOR_WORKER_ATTEMPTS: '3',
    MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: '5', MONITOR_WORKER_SOURCE_MAX_HEAD_AGE_SECONDS: '30',
    MONITOR_WORKER_HUB_MAX_HEAD_AGE_SECONDS: '30', MONITOR_WORKER_HUB_MIN_BALANCE_WEI: '0',
    MONITOR_WORKER_HUB_MAX_GAS_PRICE_WEI: '100', MONITOR_WORKER_HUB_MAX_NONCE_BACKLOG: '2' };
  assert.equal(workerServiceMonitorSettings(valid).thresholds.hubMinBalanceWei, 0n);
  for (const change of [{ MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: '' }, { SOURCE_CHAIN_RPC_URL: 'file:///PRIVATE' },
    { SOURCE_CHAIN_RPC_URL: 'https://user:PRIVATE@example.com/' }, { SOURCE_CHAIN_RPC_URL: 'https://example.com/?PRIVATE=1' },
    { MONITOR_WORKER_HUB_MIN_BALANCE_WEI: '-1' }, { MONITOR_WORKER_SIGNER_ADDRESS: ethers.ZeroAddress }]) {
    assert.throws(() => workerServiceMonitorSettings({ ...valid, ...change }), /^Error: WORKER_SERVICE_MONITOR_SETTINGS_INVALID$/);
  }
});

test('actual service monitor CLI returns 0/1/2 and never loads a worker private key', async t => {
  const f = await fixture(t);
  const env = { PATH: process.env.PATH, SOURCE_CHAIN_RPC_URL: f.settings.sourceRpcUrl, CREDITCOIN_RPC_URL: f.settings.hubRpcUrl,
    WORKER_HEALTH_PORT: String(f.settings.health.port), MONITOR_WORKER_SERVICE_TIMEOUT_MS: '1000', WORKER_HEALTH_MAX_SCAN_AGE_MS: '10000',
    WORKER_STATE_PATH: f.statePath, SOURCE_CHAIN_ID: String(scope.sourceChainId), MONITOR_WORKER_HUB_CHAIN_ID: String(scope.hubChainId),
    SOURCE_CHAIN_KEY: '1', WORKER_START_BLOCK: '10', SOURCE_CONTRACT_ADDRESS: scope.source, ASC_CONTRACT_ADDRESS: scope.asc,
    MONITOR_WORKER_SIGNER_ADDRESS: scope.signer, MONITOR_WORKER_JOB_SECONDS: '60', MONITOR_WORKER_ATTEMPTS: '3',
    MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: '5', MONITOR_WORKER_SOURCE_MAX_HEAD_AGE_SECONDS: '30', MONITOR_WORKER_HUB_MAX_HEAD_AGE_SECONDS: '30',
    MONITOR_WORKER_HUB_MIN_BALANCE_WEI: '0', MONITOR_WORKER_HUB_MAX_GAS_PRICE_WEI: '100', MONITOR_WORKER_HUB_MAX_NONCE_BACKLOG: '2' };
  const run = (extra: Record<string, string> = {}) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'script/monitor-worker-service.ts'], {
      env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    child.on('error', reject); child.on('exit', code => resolve({ code, output }));
  });
  const good = await run({ WORKER_PRIVATE_KEY: 'PRIVATE-MUST-NOT-LOAD' });
  assert.equal(good.code, 0, good.output); assert.equal(JSON.parse(good.output).status, 'SERVICE_OBSERVATIONS_OK');
  const lagged = await run({ MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: '2' });
  assert.equal(lagged.code, 1); assert.equal(JSON.parse(lagged.output).findings.includes('SOURCE_CURSOR_LAG'), true);
  const invalid = await run({ MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: '' });
  assert.equal(invalid.code, 2); assert.equal(invalid.output.trim(), 'WORKER_SERVICE_MONITOR_UNAVAILABLE');
  assert.equal(invalid.output.includes('PRIVATE'), false);
});
