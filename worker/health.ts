import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

export function workerHealthSettings(port: string | undefined, maxAge: string | undefined) {
  if (!port?.trim()) {
    if (maxAge?.trim()) throw new Error('WORKER_HEALTH_SETTINGS_INVALID');
    return undefined;
  }
  const positive = (raw: string | undefined) => !!raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0;
  if (!positive(port) || Number(port) > 65535 || !positive(maxAge)) throw new Error('WORKER_HEALTH_SETTINGS_INVALID');
  return { port: Number(port), maxScanAgeMs: Number(maxAge) };
}

/** Live process self-report, never persisted or inferred from Store/lease timestamps. */
export class WorkerHealth {
  private phase: 'STARTING' | 'RUNNING' | 'STOPPING' = 'STARTING';
  private readonly started: number;
  private scanAt?: number;
  private scanFailed = false;
  private scans = 0;
  private errors = 0;
  constructor(private readonly maxScanAgeMs: number, private readonly clock = () => performance.now()) {
    if (!Number.isSafeInteger(maxScanAgeMs) || maxScanAgeMs <= 0) throw new Error('WORKER_HEALTH_SETTINGS_INVALID');
    this.started = clock();
  }
  running(): void { if (this.phase !== 'STOPPING') this.phase = 'RUNNING'; }
  stopping(): void { this.phase = 'STOPPING'; }
  scanCompleted(): void { this.scanAt = this.clock(); this.scans++; this.scanFailed = false; }
  scanError(): void { this.errors++; this.scanFailed = true; }
  report(inFlight: number) {
    if (!Number.isSafeInteger(inFlight) || inFlight < 0) throw new Error('WORKER_HEALTH_STATE_INVALID');
    const now = this.clock(), age = this.scanAt === undefined ? null : Math.floor(now - this.scanAt);
    if (!Number.isFinite(now) || now < this.started || (age !== null && age < 0)) throw new Error('WORKER_HEALTH_CLOCK_INVALID');
    const status = this.phase !== 'RUNNING' ? this.phase : this.scanFailed ? 'SOURCE_SCAN_ERROR'
      : age === null ? 'SOURCE_SCAN_NOT_OBSERVED' : age >= this.maxScanAgeMs ? 'SOURCE_SCAN_STALE' : 'LOCAL_SCAN_RECENT';
    return { version: 1, scope: 'live-worker-self-report', status, phase: this.phase,
      eventLoop: 'RESPONDING', uptimeMs: Math.floor(now - this.started), lastSourceScanAgeMs: age,
      maxScanAgeMs: this.maxScanAgeMs, completedSourceScans: this.scans, sourceScanErrors: this.errors, inFlight,
      chainLag: 'NOT_CHECKED', hubDelivery: 'NOT_CHECKED', externalAvailability: 'NOT_CHECKED' };
  }
}

/** Loopback only, no CORS, cookies, raw diagnostics, IDs, addresses, RPC or administrative actions. */
export async function serveWorkerHealth(health: WorkerHealth, port: number, inFlight: () => number) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('WORKER_HEALTH_SETTINGS_INVALID');
  const server = createServer({ maxHeaderSize: 4096 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'close'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' || req.url !== '/health' || req.headers.origin || req.headers['transfer-encoding']
      || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); return;
    }
    // Exact bound authority prevents browser DNS-rebinding to a public hostname.
    const address = server.address();
    if (!address || typeof address === 'string' || req.headers.host !== `127.0.0.1:${address.port}`) {
      res.writeHead(404); res.end('{"error":"NOT_FOUND"}'); return;
    }
    try {
      const report = health.report(inFlight());
      res.writeHead(report.status === 'LOCAL_SCAN_RECENT' ? 200 : 503); res.end(JSON.stringify(report));
    } catch { res.writeHead(503); res.end('{"error":"WORKER_HEALTH_UNAVAILABLE"}'); }
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.timeout = 5000;
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('WORKER_HEALTH_LISTENER_UNAVAILABLE');
  return { port: address.port, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
