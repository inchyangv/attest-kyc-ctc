import { request } from 'node:http';
import { performance } from 'node:perf_hooks';

export interface WorkerProbeSettings { port: number; timeoutMs: number; maxScanAgeMs: number }
type SelfReport = {
  version: 1; scope: 'live-worker-self-report'; status: string; phase: string;
  eventLoop: 'RESPONDING'; uptimeMs: number; lastSourceScanAgeMs: number | null;
  maxScanAgeMs: number; completedSourceScans: number; sourceScanErrors: number; inFlight: number;
  chainLag: 'NOT_CHECKED'; hubDelivery: 'NOT_CHECKED'; externalAvailability: 'NOT_CHECKED';
};
export type WorkerProbeResult = {
  version: 1; scope: 'independent-loopback-worker-probe';
  status: 'LOCAL_SCAN_RECENT' | 'ATTENTION_REQUIRED' | 'UNAVAILABLE';
  code: string; elapsedMs: number; worker?: SelfReport;
  processIdentity: 'NOT_VERIFIED'; chainState: 'NOT_CHECKED'; alertDelivery: 'NOT_CHECKED';
};

export function workerProbeSettings(port: string | undefined, timeout: string | undefined, age: string | undefined): WorkerProbeSettings {
  const integer = (raw: string | undefined) => {
    if (!raw || !/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) throw new Error('WORKER_PROBE_SETTINGS_INVALID');
    return Number(raw);
  };
  const settings = { port: integer(port), timeoutMs: integer(timeout), maxScanAgeMs: integer(age) };
  if (settings.port > 65535 || settings.timeoutMs > 60000) throw new Error('WORKER_PROBE_SETTINGS_INVALID');
  return settings;
}

/** Untrusted local self-report. Never echo unexpected fields or diagnostic bodies. */
export function validateWorkerSelfReport(value: unknown, httpStatus: number, expectedAge: number): SelfReport {
  const fail = (): never => { throw new Error('WORKER_PROBE_INVALID_RESPONSE'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const r = value as SelfReport;
  const keys = ['version', 'scope', 'status', 'phase', 'eventLoop', 'uptimeMs', 'lastSourceScanAgeMs', 'maxScanAgeMs',
    'completedSourceScans', 'sourceScanErrors', 'inFlight', 'chainLag', 'hubDelivery', 'externalAvailability'];
  if (Object.keys(r).length !== keys.length || keys.some(key => !Object.hasOwn(r, key))) return fail();
  if (r.version !== 1 || r.scope !== 'live-worker-self-report' || r.eventLoop !== 'RESPONDING'
    || r.chainLag !== 'NOT_CHECKED' || r.hubDelivery !== 'NOT_CHECKED' || r.externalAvailability !== 'NOT_CHECKED') return fail();
  for (const n of [r.uptimeMs, r.completedSourceScans, r.sourceScanErrors, r.inFlight]) {
    if (!Number.isSafeInteger(n) || n < 0) return fail();
  }
  if (!Number.isSafeInteger(expectedAge) || expectedAge <= 0 || r.maxScanAgeMs !== expectedAge) return fail();
  const age = r.lastSourceScanAgeMs;
  if (age !== null && (!Number.isSafeInteger(age) || age < 0 || age > r.uptimeMs)) return fail();
  if ((age === null) !== (r.completedSourceScans === 0)) return fail();
  if (!['STARTING', 'RUNNING', 'STOPPING'].includes(r.phase)) return fail();
  const expectedStatus = r.phase !== 'RUNNING' ? r.phase
    : r.status === 'SOURCE_SCAN_ERROR' && r.sourceScanErrors > 0 ? 'SOURCE_SCAN_ERROR'
    : age === null ? 'SOURCE_SCAN_NOT_OBSERVED' : age >= expectedAge ? 'SOURCE_SCAN_STALE' : 'LOCAL_SCAN_RECENT';
  if (r.status !== expectedStatus || httpStatus !== (r.status === 'LOCAL_SCAN_RECENT' ? 200 : 503)) return fail();
  // Copy only validated scalar fields; no reference to a provider-owned object survives.
  return Object.fromEntries(keys.map(key => [key, r[key as keyof SelfReport]])) as SelfReport;
}

/** One bounded GET to a literal loopback IP. No redirects, DNS, proxy, retries, signer or Store. */
export async function probeWorker(input: WorkerProbeSettings): Promise<WorkerProbeResult> {
  const settings = workerProbeSettings(String(input.port), String(input.timeoutMs), String(input.maxScanAgeMs));
  const started = performance.now();
  return new Promise(resolve => {
    let settled = false;
    const finish = (status: WorkerProbeResult['status'], code: string, worker?: SelfReport) => {
      if (settled) return;
      settled = true; clearTimeout(timer); req.destroy();
      resolve({ version: 1, scope: 'independent-loopback-worker-probe', status, code,
        elapsedMs: Math.floor(performance.now() - started), ...(worker ? { worker } : {}),
        processIdentity: 'NOT_VERIFIED', chainState: 'NOT_CHECKED', alertDelivery: 'NOT_CHECKED' });
    };
    const timer = setTimeout(() => finish('UNAVAILABLE', 'DEADLINE_EXCEEDED'), settings.timeoutMs);
    const req = request({ hostname: '127.0.0.1', port: settings.port, path: '/health', method: 'GET',
      agent: false, maxHeaderSize: 4096, headers: { Accept: 'application/json', Connection: 'close' } }, res => {
      if (![200, 503].includes(res.statusCode ?? 0) || res.headers['content-type'] !== 'application/json'
        || res.headers['cache-control'] !== 'no-store' || res.headers['content-encoding']) {
        res.destroy(); finish('UNAVAILABLE', 'INVALID_RESPONSE'); return;
      }
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('error', () => finish('UNAVAILABLE', 'TRANSPORT_ERROR'));
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 4096) { res.destroy(); finish('UNAVAILABLE', 'INVALID_RESPONSE'); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (performance.now() - started >= settings.timeoutMs) { finish('UNAVAILABLE', 'DEADLINE_EXCEEDED'); return; }
        try {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const worker = validateWorkerSelfReport(JSON.parse(text), res.statusCode!, settings.maxScanAgeMs);
          if (worker.status === 'LOCAL_SCAN_RECENT' && worker.lastSourceScanAgeMs! + performance.now() - started >= settings.maxScanAgeMs) {
            finish('ATTENTION_REQUIRED', 'SCAN_AGE_BOUND_EXCEEDED', worker); return;
          }
          finish(worker.status === 'LOCAL_SCAN_RECENT' ? 'LOCAL_SCAN_RECENT' : 'ATTENTION_REQUIRED', worker.status, worker);
        } catch { finish('UNAVAILABLE', 'INVALID_RESPONSE'); }
      });
    });
    req.on('error', () => finish('UNAVAILABLE', 'TRANSPORT_ERROR'));
    req.end();
  });
}
