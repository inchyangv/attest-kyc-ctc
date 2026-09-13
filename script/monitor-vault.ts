/** One read-only pass. Exit 0 means no LOCAL findings, never current-chain or process health. */
import 'dotenv/config';
import { EvidenceVault } from '../pipeline/vault.js';
import { monitorVault } from '../pipeline/vault-monitor.js';

function required(name: string): string {
  const value = process.env[name]?.trim(); if (!value) throw new Error('MISSING_MONITOR_CONFIGURATION'); return value;
}
function seconds(name: string) {
  const raw = required(name);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw) * 1000) || Number(raw) <= 0) throw new Error('INVALID_MONITOR_CONFIGURATION');
  return Number(raw) * 1000;
}
try {
  if (process.argv.length !== 2) throw new Error('MONITOR_ACCEPTS_NO_ARGUMENTS');
  const limits = { screeningIntervalMs: seconds('MONITOR_SCREENING_SECONDS'), pendingIssuanceMs: seconds('MONITOR_ISSUANCE_SECONDS'),
    reviewRecordAgeMs: seconds('MONITOR_REVIEW_RECORD_SECONDS'), revocationMs: seconds('MONITOR_REVOCATION_SECONDS'),
    observationMaxAgeMs: seconds('MONITOR_OBSERVATION_SECONDS') };
  const vault = new EvidenceVault(required('EVIDENCE_VAULT_PATH'), required('EVIDENCE_VAULT_KEY'));
  const result = monitorVault(vault.monitoringSnapshot(), limits);
  console.log(JSON.stringify(result));
  if (result.findingCount) process.exitCode = 1;
} catch {
  console.error('VAULT_MONITOR_UNAVAILABLE'); process.exitCode = 2;
}
