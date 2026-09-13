import { auditWorkerServiceEvidence, readWorkerServiceEvidence, serviceEvidenceAuditSettings } from '../worker/service-evidence.js';
import { workerServiceDeploymentDigest, workerServiceMonitorSettings } from '../worker/service-monitor.js';

// Read-only audit of records created by record:worker:service. It does not run the probe or send an alert.
try {
  if (process.argv.length !== 2 || !process.env.MONITOR_WORKER_EVIDENCE_DIR?.trim()) throw new Error('invalid');
  const monitor = workerServiceMonitorSettings(process.env), deploymentDigest = workerServiceDeploymentDigest(monitor);
  const report = auditWorkerServiceEvidence(readWorkerServiceEvidence(process.env.MONITOR_WORKER_EVIDENCE_DIR.trim(), deploymentDigest),
    deploymentDigest, serviceEvidenceAuditSettings(process.env));
  console.log(JSON.stringify(report));
  process.exitCode = report.status === 'STAGING_WINDOW_COMPLETE' ? 0 : 1;
} catch {
  console.error('WORKER_SERVICE_EVIDENCE_UNAVAILABLE');
  process.exitCode = 2;
}
