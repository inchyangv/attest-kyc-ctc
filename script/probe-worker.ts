import { probeWorker, workerProbeSettings } from '../worker/health-probe.js';

// Intentionally no dotenv/config: this read-only probe does not load worker signing secrets.
try {
  if (process.argv.length !== 2) throw new Error('unexpected argument');
  const result = await probeWorker(workerProbeSettings(process.env.WORKER_HEALTH_PORT,
    process.env.MONITOR_WORKER_TIMEOUT_MS, process.env.WORKER_HEALTH_MAX_SCAN_AGE_MS));
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'LOCAL_SCAN_RECENT' ? 0 : result.status === 'ATTENTION_REQUIRED' ? 1 : 2;
} catch { console.error('WORKER_PROBE_UNAVAILABLE'); process.exitCode = 2; }
