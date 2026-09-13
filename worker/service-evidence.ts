import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkerServiceMonitorResult } from './service-monitor.js';

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_RECORDS = 20_000;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

type EvidenceEnvelope = { version: 1; recordedAt: number; reportDigest: string; report: WorkerServiceMonitorResult };
export interface ServiceEvidenceAuditSettings { maxRunGapMs: number; requiredWindowMs: number; targetMinJobs: number }

function validateReport(value: unknown): asserts value is WorkerServiceMonitorResult {
  if (!object(value) || value.version !== 1 || value.scope !== 'independent-worker-service-monitor'
    || !['SERVICE_OBSERVATIONS_OK', 'ATTENTION_REQUIRED', 'UNAVAILABLE'].includes(String(value.status))
    || typeof value.code !== 'string' || !/^[A-Z0-9_]+$/.test(value.code)
    || typeof value.deploymentDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.deploymentDigest)
    || !integer(value.observedAt) || !integer(value.elapsedMs)) throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
}

function validateEnvelope(value: unknown): EvidenceEnvelope {
  if (!object(value) || Object.keys(value).length !== 4 || value.version !== 1 || !integer(value.recordedAt)
    || typeof value.reportDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.reportDigest)) {
    throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  }
  validateReport(value.report);
  if (value.recordedAt < value.report.observedAt || digest(JSON.stringify(value.report)) !== value.reportDigest) {
    throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  }
  return value as unknown as EvidenceEnvelope;
}

/** Save one already-redacted report as an atomic, fsynced, immutable-named local observation. */
export function recordWorkerServiceEvidence(directory: string, report: WorkerServiceMonitorResult, recordedAt = Date.now()): string {
  validateReport(report);
  if (!directory || !integer(recordedAt) || recordedAt < report.observedAt) throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = `run-${report.observedAt}-${randomUUID()}.json`, path = join(directory, filename), tmp = `${path}.tmp`;
  const envelope: EvidenceEnvelope = { version: 1, recordedAt, reportDigest: digest(JSON.stringify(report)), report };
  const encoded = JSON.stringify(envelope) + '\n';
  if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES) throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, encoded); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, path);
    const dir = openSync(directory, constants.O_RDONLY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
    return path;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function readWorkerServiceEvidence(directory: string, deploymentDigest: string): WorkerServiceMonitorResult[] {
  if (!/^[0-9a-f]{64}$/.test(deploymentDigest) || !lstatSync(directory).isDirectory()) {
    throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  }
  const entries = readdirSync(directory);
  if (entries.some(name => !/^run-\d+-[0-9a-f-]{36}\.json$/.test(name))) throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  const names = entries.sort();
  if (names.length > MAX_RECORDS) throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
  const reports = names.map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) throw new Error('WORKER_SERVICE_EVIDENCE_INVALID');
    const raw = readFileSync(path);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    return validateEnvelope(value).report;
  });
  if (reports.some(report => report.deploymentDigest !== deploymentDigest)) throw new Error('WORKER_SERVICE_EVIDENCE_SCOPE_MISMATCH');
  return reports.sort((a, b) => a.observedAt - b.observedAt);
}

function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percent: number) => sorted.length ? sorted[Math.ceil(sorted.length * percent / 100) - 1] : null;
  return { sampleCount: sorted.length, p50: at(50), p95: at(95), p99: at(99) };
}

/** Read-only missed-run and staging-window audit. An exit finding is not a delivered alert. */
export function auditWorkerServiceEvidence(reports: WorkerServiceMonitorResult[], deploymentDigest: string,
  settings: ServiceEvidenceAuditSettings, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(deploymentDigest) || !integer(now) || !integer(settings.maxRunGapMs) || settings.maxRunGapMs <= 0
    || !integer(settings.requiredWindowMs) || settings.requiredWindowMs <= 0 || !integer(settings.targetMinJobs)) {
    throw new Error('WORKER_SERVICE_EVIDENCE_SETTINGS_INVALID');
  }
  if (reports.some(report => report.deploymentDigest !== deploymentDigest || report.observedAt > now)) {
    throw new Error('WORKER_SERVICE_EVIDENCE_SCOPE_MISMATCH');
  }
  const sorted = [...reports].sort((a, b) => a.observedAt - b.observedAt);
  const boundary = now - settings.requiredWindowMs;
  const before = sorted.filter(report => report.observedAt <= boundary).at(-1);
  const window = [...(before ? [before] : []), ...sorted.filter(report => report.observedAt > boundary)];
  const findings: string[] = [];
  if (!sorted.length) findings.push('PROBE_NEVER_RECORDED');
  const latest = sorted.at(-1);
  if (latest && now - latest.observedAt >= settings.maxRunGapMs) findings.push('PROBE_RUN_MISSED');
  if (window.some((report, index) => index > 0 && report.observedAt - window[index - 1].observedAt >= settings.maxRunGapMs)) {
    findings.push('PROBE_RUN_GAP');
  }
  if (!before) findings.push('STAGING_WINDOW_INCOMPLETE');
  const statusCounts = { SERVICE_OBSERVATIONS_OK: 0, ATTENTION_REQUIRED: 0, UNAVAILABLE: 0 };
  for (const report of window) statusCounts[report.status]++;
  if (statusCounts.ATTENTION_REQUIRED) findings.push('ATTENTION_SAMPLES_PRESENT');
  if (statusCounts.UNAVAILABLE) findings.push('UNAVAILABLE_SAMPLES_PRESENT');
  const maxRetainedJobs = Math.max(0, ...window.map(report => report.state?.totalJobs ?? 0));
  if (maxRetainedJobs < settings.targetMinJobs) findings.push('TARGET_LOAD_NOT_OBSERVED');
  return { version: 1, scope: 'worker-service-staging-evidence', deploymentDigest, observedAt: now,
    status: findings.length ? 'ATTENTION_REQUIRED' : 'STAGING_WINDOW_COMPLETE', findings,
    settings: { ...settings }, sampleCount: window.length, statusCounts,
    firstObservedAt: window[0]?.observedAt ?? null, lastObservedAt: latest?.observedAt ?? null,
    latestAgeMs: latest ? now - latest.observedAt : null, maxRetainedJobs,
    probeLatencyMs: { ok: distribution(window.filter(r => r.status === 'SERVICE_OBSERVATIONS_OK').map(r => r.elapsedMs)),
      attention: distribution(window.filter(r => r.status === 'ATTENTION_REQUIRED').map(r => r.elapsedMs)),
      unavailable: distribution(window.filter(r => r.status === 'UNAVAILABLE').map(r => r.elapsedMs)) },
    latestRetainedStateMetrics: latest?.state?.retainedStateMetrics ?? null,
    alertDelivery: 'NOT_CHECKED', schedulerInstallation: 'NOT_CHECKED', targetLoadMeaning: 'OPERATOR_CONFIGURED_NOT_APPROVED' };
}

export function serviceEvidenceAuditSettings(env: NodeJS.ProcessEnv): ServiceEvidenceAuditSettings {
  const number = (name: string, minimum = 1) => {
    const raw = env[name]?.trim(), value = Number(raw);
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum) {
      throw new Error('WORKER_SERVICE_EVIDENCE_SETTINGS_INVALID');
    }
    return value;
  };
  const interval = number('MONITOR_WORKER_RUN_INTERVAL_SECONDS');
  const missed = number('MONITOR_WORKER_MISSED_AFTER_SECONDS');
  const staging = number('MONITOR_WORKER_STAGING_SECONDS', 7 * 24 * 60 * 60);
  if (missed <= interval) throw new Error('WORKER_SERVICE_EVIDENCE_SETTINGS_INVALID');
  return { maxRunGapMs: missed * 1000, requiredWindowMs: staging * 1000,
    targetMinJobs: number('MONITOR_WORKER_STAGING_MIN_JOBS', 0) };
}
