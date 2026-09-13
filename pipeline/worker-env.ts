import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const workerEnvironmentNames = new Set([
  'SOURCE_CHAIN_RPC_URL', 'CREDITCOIN_RPC_URL', 'PROOF_BUILDER_URL', 'WORKER_PRIVATE_KEY', 'WORKER_SIGNER_ADDRESS',
  'SOURCE_CONTRACT_ADDRESS', 'ASC_CONTRACT_ADDRESS', 'SOURCE_CHAIN_KEY', 'WORKER_CONFIRMATIONS',
  'WORKER_HUB_CONFIRMATIONS', 'WORKER_SCAN_CHUNK', 'WORKER_POLL_MS', 'WORKER_CONCURRENCY',
  'WORKER_MAX_ATTEMPTS', 'WORKER_STATE_PATH', 'WORKER_START_BLOCK', 'WORKER_HEALTH_PORT',
  'WORKER_HEALTH_MAX_SCAN_AGE_MS',
]);
const required = new Set([
  'SOURCE_CHAIN_RPC_URL', 'CREDITCOIN_RPC_URL', 'PROOF_BUILDER_URL', 'WORKER_PRIVATE_KEY', 'WORKER_SIGNER_ADDRESS',
  'SOURCE_CONTRACT_ADDRESS', 'ASC_CONTRACT_ADDRESS', 'WORKER_START_BLOCK',
]);

export class WorkerEnvironmentError extends Error {
  constructor(readonly code: 'WORKER_ENV_FILE_UNSAFE' | 'WORKER_ENV_FORMAT' | 'WORKER_ENV_KEY_FORBIDDEN' | 'WORKER_ENV_REQUIRED') {
    super(code); this.name = 'WorkerEnvironmentError';
  }
}

/** Checks names and file controls without returning or reflecting any value. */
export function checkWorkerEnvironmentFile(path: string, forbiddenRootEnv?: string): string[] {
  let raw: string, actual: string;
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error('symlink');
    actual = realpathSync(path);
    const info = statSync(actual);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 65_536) throw new Error('unsafe');
    if (forbiddenRootEnv && actual === resolve(forbiddenRootEnv)) throw new Error('root env');
    raw = readFileSync(actual, 'utf8');
  } catch { throw new WorkerEnvironmentError('WORKER_ENV_FILE_UNSAFE'); }
  const seen = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || seen.has(match[1])) throw new WorkerEnvironmentError('WORKER_ENV_FORMAT');
    if (!workerEnvironmentNames.has(match[1])) throw new WorkerEnvironmentError('WORKER_ENV_KEY_FORBIDDEN');
    if (required.has(match[1]) && !match[2].trim()) throw new WorkerEnvironmentError('WORKER_ENV_REQUIRED');
    seen.add(match[1]);
  }
  if ([...required].some(name => !seen.has(name))) throw new WorkerEnvironmentError('WORKER_ENV_REQUIRED');
  return [...seen].sort();
}
