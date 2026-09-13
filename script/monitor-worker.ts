import 'dotenv/config';
import { monitorWorker, readWorkerMonitorState } from '../worker/monitor.js';

function required(name: string): string { const value = process.env[name]?.trim(); if (!value) throw new Error('missing monitor setting'); return value; }
function positive(name: string): number {
  const raw = required(name), value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) throw new Error('invalid monitor setting');
  return value;
}
try {
  if (process.argv.length !== 2) throw new Error('unexpected argument');
  const scope = { sourceChainId: positive('SOURCE_CHAIN_ID'), hubChainId: positive('MONITOR_WORKER_HUB_CHAIN_ID'),
    chainKey: positive('SOURCE_CHAIN_KEY'), startBlock: positive('WORKER_START_BLOCK'), source: required('SOURCE_CONTRACT_ADDRESS'),
    asc: required('ASC_CONTRACT_ADDRESS'), signer: required('MONITOR_WORKER_SIGNER_ADDRESS') };
  const limits = { jobAgeMs: positive('MONITOR_WORKER_JOB_SECONDS') * 1000, attempts: positive('MONITOR_WORKER_ATTEMPTS') };
  const result = monitorWorker(readWorkerMonitorState(required('WORKER_STATE_PATH')), scope, limits);
  console.log(JSON.stringify(result)); if (result.findingCount) process.exitCode = 1;
} catch { console.error('WORKER_MONITOR_UNAVAILABLE'); process.exitCode = 2; }
