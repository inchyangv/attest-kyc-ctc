import { probeWorkerService, workerServiceMonitorSettings } from '../worker/service-monitor.js';

// Intentionally no dotenv/config or worker config import: no signing key is loaded.
try {
  if (process.argv.length !== 2) throw new Error('unexpected argument');
  const report = await probeWorkerService(workerServiceMonitorSettings(process.env));
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'SERVICE_OBSERVATIONS_OK' ? 0 : report.status === 'ATTENTION_REQUIRED' ? 1 : 2;
} catch {
  console.error('WORKER_SERVICE_MONITOR_UNAVAILABLE');
  process.exitCode = 2;
}
