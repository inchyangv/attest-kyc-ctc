import { recordWorkerServiceEvidence } from '../worker/service-evidence.js';
import { probeWorkerService, workerServiceMonitorSettings } from '../worker/service-monitor.js';

// Explicit mutating evidence command. It writes only the redacted service report, never worker state or keys.
try {
  if (process.argv.length !== 2 || !process.env.MONITOR_WORKER_EVIDENCE_DIR?.trim()) throw new Error('invalid');
  const report = await probeWorkerService(workerServiceMonitorSettings(process.env));
  recordWorkerServiceEvidence(process.env.MONITOR_WORKER_EVIDENCE_DIR.trim(), report);
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'SERVICE_OBSERVATIONS_OK' ? 0 : report.status === 'ATTENTION_REQUIRED' ? 1 : 2;
} catch {
  console.error('WORKER_SERVICE_RECORD_UNAVAILABLE');
  process.exitCode = 2;
}
