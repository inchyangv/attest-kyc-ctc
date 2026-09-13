import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { ethers } from 'ethers';
import type { Job, RelayEnvelope, SourceCheckpoint, WorkerScope } from './store.js';

export const WORKER_MONITOR_MAX_BYTES = 16 * 1024 * 1024;
type State = { version: number; cursor: number; scope: WorkerScope; jobs: Record<string, Job>;
  sourceCheckpoints: SourceCheckpoint[]; relay?: RelayEnvelope; sourceHold?: string; hubStartNonce?: number; hubHold?: string };
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const hash = (value: string) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const address = (value: string) => typeof value === 'string' && ethers.isAddress(value) && value.toLowerCase() !== ethers.ZeroAddress;
const object = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
function requireThat(ok: unknown): asserts ok { if (!ok) throw new Error('INVALID_WORKER_MONITOR_STATE'); }

/** Existing regular file only. No Store constructor, directory creation, lock stealing or RPC. */
export function readWorkerMonitorState(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    requireThat(stat.isFile() && stat.size <= WORKER_MONITOR_MAX_BYTES);
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(65536, WORKER_MONITOR_MAX_BYTES + 1 - total));
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      total += n; requireThat(total <= WORKER_MONITOR_MAX_BYTES);
      chunks.push(chunk.subarray(0, n));
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
  } finally { closeSync(fd); }
}

/** Snapshot diagnostics. A file is not a heartbeat or a current-chain receipt/finality check. */
export function monitorWorker(value: unknown, expected: WorkerScope,
  limits: { jobAgeMs: number; attempts: number }, now = Date.now()) {
  requireThat(integer(now) && integer(limits.jobAgeMs) && limits.jobAgeMs > 0 && integer(limits.attempts) && limits.attempts > 0);
  requireThat(object(value)); const data = value as State;
  requireThat(data.version === 1 && object(data.scope) && object(data.jobs) && integer(data.cursor));
  for (const field of ['sourceChainId', 'hubChainId', 'chainKey', 'startBlock'] as const) {
    requireThat(integer(expected[field]) && expected[field] > 0 && data.scope[field] === expected[field]);
  }
  for (const field of ['source', 'asc', 'signer'] as const) {
    requireThat(address(expected[field]) && address(data.scope[field]) && data.scope[field].toLowerCase() === expected[field].toLowerCase());
  }
  requireThat(Array.isArray(data.sourceCheckpoints) && data.sourceCheckpoints.length > 0 && data.sourceCheckpoints.length <= 129);
  let previous = -1;
  for (const checkpoint of data.sourceCheckpoints) {
    requireThat(integer(checkpoint.height) && checkpoint.height > previous && hash(checkpoint.hash)); previous = checkpoint.height;
  }
  requireThat(data.sourceCheckpoints[0].height === expected.startBlock - 1 && previous === data.cursor);
  requireThat(data.sourceHold === undefined || typeof data.sourceHold === 'string');
  requireThat(data.hubStartNonce === undefined || integer(data.hubStartNonce));
  requireThat(data.hubHold === undefined || typeof data.hubHold === 'string');
  requireThat(data.relay === undefined || object(data.relay));
  const counts: Record<string, number> = {}, states: Record<string, number> = {};
  const findings: { caseDigest?: string; code: string; ageMs?: number }[] = [];
  let findingCount = 0, oldestPendingAgeMs = 0;
  const add = (code: string, txHash?: string, ageMs?: number) => {
    findingCount++; counts[code] = (counts[code] ?? 0) + 1;
    if (findings.length < 100) findings.push({ code, ...(txHash ? { caseDigest: ethers.id(txHash) } : {}), ...(ageMs === undefined ? {} : { ageMs }) });
  };
  if (data.sourceHold) add('SOURCE_SAFETY_HOLD');
  if (data.hubStartNonce === undefined) add('HUB_SIGNER_BASELINE_MISSING');
  if (data.hubHold) add('HUB_SAFETY_HOLD');
  for (const [key, job] of Object.entries(data.jobs)) {
    requireThat(object(job) && hash(key) && job.txHash === key && integer(job.blockNumber) && job.blockNumber >= expected.startBlock
      && job.blockNumber <= data.cursor && hash(job.blockHash!) && integer(job.transactionIndex!)
      && integer(job.discoveredAt) && integer(job.updatedAt) && job.updatedAt >= job.discoveredAt && job.updatedAt <= now
      && integer(job.attempts) && integer(job.action) && job.action <= 5 && integer(job.logCount) && job.logCount > 0
      && (job.lastError === undefined || typeof job.lastError === 'string')
      && ['discovered', 'attested', 'submitted', 'done', 'skipped', 'dead'].includes(job.state));
    states[job.state] = (states[job.state] ?? 0) + 1;
    if (job.skipObservation !== undefined) {
      const observation = job.skipObservation;
      requireThat(object(observation) && integer(observation.blockNumber) && hash(observation.blockHash)
        && integer(observation.confirmations) && observation.confirmations > 0 && integer(observation.observedAt)
        && observation.observedAt <= job.updatedAt && job.state === 'skipped');
    }
    if (job.state === 'skipped' && !job.skipObservation) add('SKIP_WITHOUT_CONFIRMED_OBSERVATION', key);
    const age = now - job.discoveredAt;
    if (job.state === 'dead') add('DEAD_LETTER', key, age);
    else if (!['done', 'skipped'].includes(job.state)) {
      oldestPendingAgeMs = Math.max(oldestPendingAgeMs, age);
      if (age >= limits.jobAgeMs) add('JOB_OVERDUE', key, age);
      if (job.attempts >= limits.attempts) add('RETRY_THRESHOLD_REACHED', key);
      if (job.lastError) add('PENDING_JOB_ERROR', key);
      if (job.state === 'submitted' && data.relay?.sourceTxHash !== key) add('SUBMITTED_WITHOUT_RELAY_ENVELOPE', key);
    }
  }
  if (data.relay) {
    const relay = data.relay, job = data.jobs[relay.sourceTxHash];
    requireThat(object(relay) && hash(relay.sourceTxHash) && hash(relay.hash) && hash(relay.queryId) && integer(relay.nonce)
      && relay.chainId === expected.hubChainId && address(relay.to) && address(relay.signer)
      && relay.to.toLowerCase() === expected.asc.toLowerCase() && relay.signer.toLowerCase() === expected.signer.toLowerCase()
      && job?.state === 'submitted' && job.ascTxHash === relay.hash && job.queryId === relay.queryId);
    add('RELAY_NONCE_UNRESOLVED', relay.sourceTxHash, now - job.discoveredAt);
  }
  const percentile = (values: number[], numerator: number) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.ceil(sorted.length * numerator / 100) - 1];
  };
  const distribution = (values: number[]) => ({ sampleCount: values.length,
    p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99) });
  const allJobs = Object.values(data.jobs);
  const completedLatency = allJobs.filter(job => job.state === 'done').map(job => job.updatedAt - job.discoveredAt);
  const skippedLatency = allJobs.filter(job => job.state === 'skipped').map(job => job.updatedAt - job.discoveredAt);
  const failedLatency = allJobs.filter(job => job.state === 'dead').map(job => job.updatedAt - job.discoveredAt);
  const pendingAge = allJobs.filter(job => !['done', 'skipped', 'dead'].includes(job.state)).map(job => now - job.discoveredAt);
  const overduePendingAge = pendingAge.filter(age => age >= limits.jobAgeMs);
  const terminalCount = completedLatency.length + skippedLatency.length + failedLatency.length;
  const attempts = allJobs.map(job => job.attempts);
  return { version: 1, observedAt: now, scope: 'local-worker-state', processLiveness: 'NOT_CHECKED', chainState: 'NOT_CHECKED',
    status: findingCount ? 'ATTENTION_REQUIRED' : 'NO_LOCAL_FINDINGS', limits: { jobAgeMs: limits.jobAgeMs, attempts: limits.attempts },
    cursor: data.cursor, checkpoints: data.sourceCheckpoints.length, totalJobs: Object.keys(data.jobs).length, states, oldestPendingAgeMs,
    findingCount, counts, findings, findingsTruncated: findingCount > 100,
    retainedStateMetrics: { window: 'RETAINED_STATE_LIFETIME',
      terminalOutcomes: { sampleCount: terminalCount, completed: completedLatency.length, skipped: skippedLatency.length,
        failed: failedLatency.length, failureRatePpm: terminalCount ? Math.floor(failedLatency.length * 1_000_000 / terminalCount) : null },
      completedLatencyMs: distribution(completedLatency), skippedLatencyMs: distribution(skippedLatency),
      failedLatencyMs: distribution(failedLatency), pendingAgeMs: distribution(pendingAge),
      overduePendingAgeMs: distribution(overduePendingAge), attempts: { ...distribution(attempts),
        total: attempts.reduce((sum, value) => sum + value, 0), retriedJobs: attempts.filter(value => value > 0).length } } };
}
