import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { probeWorker, workerProbeSettings, type WorkerProbeSettings, type WorkerProbeResult } from './health-probe.js';
import { monitorWorker, readWorkerMonitorState } from './monitor.js';
import type { WorkerScope } from './store.js';

const RPC_MAX_BYTES = 16 * 1024;
const quantityPattern = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export interface WorkerServiceThresholds {
  sourceMaxBlockLag: number;
  sourceMaxHeadAgeSeconds: number;
  hubMaxHeadAgeSeconds: number;
  hubMinBalanceWei: bigint;
  hubMaxGasPriceWei: bigint;
  hubMaxNonceBacklog: number;
}

export interface WorkerServiceMonitorSettings {
  health: WorkerProbeSettings;
  sourceRpcUrl: string;
  hubRpcUrl: string;
  statePath: string;
  scope: WorkerScope;
  stateLimits: { jobAgeMs: number; attempts: number };
  thresholds: WorkerServiceThresholds;
}

type ChainHead = { chainId: number; blockNumber: number; timestamp: number };
type HubSample = ChainHead & { latestNonce: number; pendingNonce: number; balanceWei: bigint; gasPriceWei: bigint };
type StateReport = ReturnType<typeof monitorWorker>;

export type WorkerServiceMonitorResult = {
  version: 1;
  scope: 'independent-worker-service-monitor';
  status: 'SERVICE_OBSERVATIONS_OK' | 'ATTENTION_REQUIRED' | 'UNAVAILABLE';
  code: string;
  deploymentDigest: string;
  observedAt: number;
  elapsedMs: number;
  processIdentity: 'NOT_VERIFIED';
  chainState: 'OBSERVED_FROM_CONFIGURED_RPC_NOT_INDEPENDENTLY_VERIFIED' | 'NOT_CHECKED';
  alertDelivery: 'NOT_CHECKED';
  health?: WorkerProbeResult;
  state?: StateReport;
  chains?: {
    source: { chainId: number; headBlock: number; headAgeSeconds: number; workerCursor: number; lagBlocks: number };
    hub: { chainId: number; headBlock: number; headAgeSeconds: number; latestNonce: number; pendingNonce: number;
      nonceBacklog: number; balanceWei: string; gasPriceWei: string };
  };
  findings?: string[];
};

export function workerServiceDeploymentDigest(settings: Pick<WorkerServiceMonitorSettings, 'health' | 'scope'>): string {
  const material = { sourceChainId: settings.scope.sourceChainId, hubChainId: settings.scope.hubChainId,
    chainKey: settings.scope.chainKey, startBlock: settings.scope.startBlock, source: settings.scope.source.toLowerCase(),
    asc: settings.scope.asc.toLowerCase(), signer: settings.scope.signer.toLowerCase(), healthPort: settings.health.port };
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function endpoint(raw: string): URL {
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID'); }
  if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.hash || value.search) {
    throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  }
  return value;
}

function decimal(raw: string | undefined, allowZero = false): number {
  if (!raw || !/^\d+$/.test(raw)) throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  return value;
}

function decimalBigInt(raw: string | undefined, allowZero = false): bigint {
  if (!raw || !/^\d+$/.test(raw)) throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  const value = BigInt(raw);
  if (value < (allowZero ? 0n : 1n)) throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  return value;
}

/** Explicit read-only settings. This module never imports worker signing configuration or dotenv. */
export function workerServiceMonitorSettings(env: NodeJS.ProcessEnv): WorkerServiceMonitorSettings {
  const sourceRpcUrl = endpoint(required(env, 'SOURCE_CHAIN_RPC_URL')).toString();
  const hubRpcUrl = endpoint(required(env, 'CREDITCOIN_RPC_URL')).toString();
  const signer = required(env, 'MONITOR_WORKER_SIGNER_ADDRESS');
  const source = required(env, 'SOURCE_CONTRACT_ADDRESS'), asc = required(env, 'ASC_CONTRACT_ADDRESS');
  if (!ethers.isAddress(signer) || signer === ethers.ZeroAddress || !ethers.isAddress(source) || source === ethers.ZeroAddress
    || !ethers.isAddress(asc) || asc === ethers.ZeroAddress) throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  return {
    health: workerProbeSettings(required(env, 'WORKER_HEALTH_PORT'), required(env, 'MONITOR_WORKER_SERVICE_TIMEOUT_MS'),
      required(env, 'WORKER_HEALTH_MAX_SCAN_AGE_MS')),
    sourceRpcUrl, hubRpcUrl, statePath: required(env, 'WORKER_STATE_PATH'),
    scope: { sourceChainId: decimal(env.SOURCE_CHAIN_ID), hubChainId: decimal(env.MONITOR_WORKER_HUB_CHAIN_ID),
      chainKey: decimal(env.SOURCE_CHAIN_KEY), startBlock: decimal(env.WORKER_START_BLOCK), source, asc, signer },
    stateLimits: { jobAgeMs: decimal(env.MONITOR_WORKER_JOB_SECONDS) * 1000, attempts: decimal(env.MONITOR_WORKER_ATTEMPTS) },
    thresholds: { sourceMaxBlockLag: decimal(env.MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG),
      sourceMaxHeadAgeSeconds: decimal(env.MONITOR_WORKER_SOURCE_MAX_HEAD_AGE_SECONDS),
      hubMaxHeadAgeSeconds: decimal(env.MONITOR_WORKER_HUB_MAX_HEAD_AGE_SECONDS),
      hubMinBalanceWei: decimalBigInt(env.MONITOR_WORKER_HUB_MIN_BALANCE_WEI, true),
      hubMaxGasPriceWei: decimalBigInt(env.MONITOR_WORKER_HUB_MAX_GAS_PRICE_WEI),
      hubMaxNonceBacklog: decimal(env.MONITOR_WORKER_HUB_MAX_NONCE_BACKLOG) }
  };
}

function quantity(value: unknown): bigint {
  if (typeof value !== 'string' || !quantityPattern.test(value)) throw new Error('WORKER_SERVICE_RPC_INVALID');
  return BigInt(value);
}

function safeQuantity(value: unknown): number {
  const parsed = quantity(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WORKER_SERVICE_RPC_INVALID');
  return Number(parsed);
}

async function rpc(url: URL, method: string, params: unknown[], id: number, signal: AbortSignal): Promise<unknown> {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve(value);
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send({ protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname,
      method: 'POST', agent: false, maxHeaderSize: 4096, signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Length': String(body.length), Connection: 'close' } }, res => {
      if (res.statusCode !== 200 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(String(res.headers['content-type'] ?? ''))
        || res.headers['content-encoding']) {
        res.destroy(); finish(new Error('WORKER_SERVICE_RPC_INVALID')); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('error', () => finish(new Error('WORKER_SERVICE_RPC_UNAVAILABLE')));
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RPC_MAX_BYTES) { res.destroy(); finish(new Error('WORKER_SERVICE_RPC_INVALID')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const value = JSON.parse(text);
          if (!object(value) || Object.keys(value).length !== 3 || value.jsonrpc !== '2.0' || value.id !== id
            || !Object.hasOwn(value, 'result')) throw new Error('WORKER_SERVICE_RPC_INVALID');
          finish(undefined, value.result);
        } catch { finish(new Error('WORKER_SERVICE_RPC_INVALID')); }
      });
    });
    req.on('error', () => finish(new Error('WORKER_SERVICE_RPC_UNAVAILABLE')));
    req.end(body);
  });
}

async function chainHead(url: URL, firstId: number, signal: AbortSignal): Promise<ChainHead> {
  const [chainId, block] = await Promise.all([
    rpc(url, 'eth_chainId', [], firstId, signal), rpc(url, 'eth_getBlockByNumber', ['latest', false], firstId + 1, signal)
  ]);
  if (!object(block)) throw new Error('WORKER_SERVICE_RPC_INVALID');
  return { chainId: safeQuantity(chainId), blockNumber: safeQuantity(block.number), timestamp: safeQuantity(block.timestamp) };
}

async function hubSample(url: URL, signer: string, signal: AbortSignal): Promise<HubSample> {
  const [head, latest, pending, balance, gas] = await Promise.all([
    chainHead(url, 10, signal), rpc(url, 'eth_getTransactionCount', [signer, 'latest'], 12, signal),
    rpc(url, 'eth_getTransactionCount', [signer, 'pending'], 13, signal), rpc(url, 'eth_getBalance', [signer, 'latest'], 14, signal),
    rpc(url, 'eth_gasPrice', [], 15, signal)
  ]);
  return { ...head, latestNonce: safeQuantity(latest), pendingNonce: safeQuantity(pending), balanceWei: quantity(balance), gasPriceWei: quantity(gas) };
}

const elapsed = (started: number) => Math.floor(performance.now() - started);

/** One bounded live/state/two-chain observation. No signing, transaction, retry, lease or alert action. */
export async function probeWorkerService(settingsInput: WorkerServiceMonitorSettings, now = Date.now()): Promise<WorkerServiceMonitorResult> {
  const settings = workerServiceMonitorSettings({
    SOURCE_CHAIN_RPC_URL: settingsInput.sourceRpcUrl, CREDITCOIN_RPC_URL: settingsInput.hubRpcUrl,
    WORKER_HEALTH_PORT: String(settingsInput.health.port), MONITOR_WORKER_SERVICE_TIMEOUT_MS: String(settingsInput.health.timeoutMs),
    WORKER_HEALTH_MAX_SCAN_AGE_MS: String(settingsInput.health.maxScanAgeMs), WORKER_STATE_PATH: settingsInput.statePath,
    SOURCE_CHAIN_ID: String(settingsInput.scope.sourceChainId), MONITOR_WORKER_HUB_CHAIN_ID: String(settingsInput.scope.hubChainId),
    SOURCE_CHAIN_KEY: String(settingsInput.scope.chainKey), WORKER_START_BLOCK: String(settingsInput.scope.startBlock),
    SOURCE_CONTRACT_ADDRESS: settingsInput.scope.source, ASC_CONTRACT_ADDRESS: settingsInput.scope.asc,
    MONITOR_WORKER_SIGNER_ADDRESS: settingsInput.scope.signer,
    MONITOR_WORKER_JOB_SECONDS: String(settingsInput.stateLimits.jobAgeMs / 1000), MONITOR_WORKER_ATTEMPTS: String(settingsInput.stateLimits.attempts),
    MONITOR_WORKER_SOURCE_MAX_BLOCK_LAG: String(settingsInput.thresholds.sourceMaxBlockLag),
    MONITOR_WORKER_SOURCE_MAX_HEAD_AGE_SECONDS: String(settingsInput.thresholds.sourceMaxHeadAgeSeconds),
    MONITOR_WORKER_HUB_MAX_HEAD_AGE_SECONDS: String(settingsInput.thresholds.hubMaxHeadAgeSeconds),
    MONITOR_WORKER_HUB_MIN_BALANCE_WEI: String(settingsInput.thresholds.hubMinBalanceWei),
    MONITOR_WORKER_HUB_MAX_GAS_PRICE_WEI: String(settingsInput.thresholds.hubMaxGasPriceWei),
    MONITOR_WORKER_HUB_MAX_NONCE_BACKLOG: String(settingsInput.thresholds.hubMaxNonceBacklog)
  });
  if (!Number.isSafeInteger(now) || now < 0 || settings.stateLimits.jobAgeMs % 1000 !== 0) {
    throw new Error('WORKER_SERVICE_MONITOR_SETTINGS_INVALID');
  }
  const started = performance.now();
  const deploymentDigest = workerServiceDeploymentDigest(settings);
  const state = monitorWorker(readWorkerMonitorState(settings.statePath), settings.scope, settings.stateLimits, now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.health.timeoutMs);
  try {
    const [health, source, hub] = await Promise.all([
      probeWorker(settings.health), chainHead(endpoint(settings.sourceRpcUrl), 1, controller.signal),
      hubSample(endpoint(settings.hubRpcUrl), settings.scope.signer, controller.signal)
    ]);
    if (elapsed(started) >= settings.health.timeoutMs || health.status === 'UNAVAILABLE' || source.chainId !== settings.scope.sourceChainId
      || hub.chainId !== settings.scope.hubChainId || source.blockNumber < state.cursor || hub.pendingNonce < hub.latestNonce) {
      return { version: 1, scope: 'independent-worker-service-monitor', status: 'UNAVAILABLE', code: 'OBSERVATION_UNAVAILABLE', deploymentDigest,
        observedAt: now, elapsedMs: elapsed(started), processIdentity: 'NOT_VERIFIED', chainState: 'NOT_CHECKED', alertDelivery: 'NOT_CHECKED' };
    }
    const nowSeconds = Math.floor(now / 1000);
    if (source.timestamp > nowSeconds || hub.timestamp > nowSeconds) throw new Error('WORKER_SERVICE_RPC_INVALID');
    const sourceAge = nowSeconds - source.timestamp, hubAge = nowSeconds - hub.timestamp;
    const sourceLag = source.blockNumber - state.cursor, nonceBacklog = hub.pendingNonce - hub.latestNonce;
    const findings: string[] = [];
    if (health.status !== 'LOCAL_SCAN_RECENT') findings.push('WORKER_SELF_REPORT_ATTENTION');
    if (state.findingCount) findings.push('LOCAL_STATE_ATTENTION');
    if (sourceLag >= settings.thresholds.sourceMaxBlockLag) findings.push('SOURCE_CURSOR_LAG');
    if (sourceAge >= settings.thresholds.sourceMaxHeadAgeSeconds) findings.push('SOURCE_HEAD_STALE');
    if (hubAge >= settings.thresholds.hubMaxHeadAgeSeconds) findings.push('HUB_HEAD_STALE');
    if (hub.balanceWei < settings.thresholds.hubMinBalanceWei) findings.push('HUB_BALANCE_LOW');
    if (hub.gasPriceWei >= settings.thresholds.hubMaxGasPriceWei) findings.push('HUB_GAS_PRICE_HIGH');
    if (nonceBacklog >= settings.thresholds.hubMaxNonceBacklog) findings.push('HUB_NONCE_BACKLOG');
    const report: WorkerServiceMonitorResult = { version: 1, scope: 'independent-worker-service-monitor', deploymentDigest,
      status: findings.length ? 'ATTENTION_REQUIRED' : 'SERVICE_OBSERVATIONS_OK', code: findings.length ? 'THRESHOLD_FINDINGS' : 'OBSERVATIONS_WITHIN_THRESHOLDS',
      observedAt: now, elapsedMs: elapsed(started), processIdentity: 'NOT_VERIFIED',
      chainState: 'OBSERVED_FROM_CONFIGURED_RPC_NOT_INDEPENDENTLY_VERIFIED', alertDelivery: 'NOT_CHECKED', health, state,
      chains: { source: { chainId: source.chainId, headBlock: source.blockNumber, headAgeSeconds: sourceAge,
        workerCursor: state.cursor, lagBlocks: sourceLag }, hub: { chainId: hub.chainId, headBlock: hub.blockNumber, headAgeSeconds: hubAge,
        latestNonce: hub.latestNonce, pendingNonce: hub.pendingNonce, nonceBacklog, balanceWei: hub.balanceWei.toString(), gasPriceWei: hub.gasPriceWei.toString() } }, findings };
    return report;
  } catch {
    return { version: 1, scope: 'independent-worker-service-monitor', status: 'UNAVAILABLE', code: 'OBSERVATION_UNAVAILABLE', deploymentDigest,
      observedAt: now, elapsedMs: elapsed(started), processIdentity: 'NOT_VERIFIED', chainState: 'NOT_CHECKED', alertDelivery: 'NOT_CHECKED' };
  } finally { clearTimeout(timer); controller.abort(); }
}
