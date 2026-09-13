import 'dotenv/config';
import { integerSetting } from './settings.js';
import { workerHealthSettings } from './health.js';
import { ethers } from 'ethers';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`environment variable ${name} is not set (check .env)`);
  return v;
}
function num(name: string, dflt: number, min = 0): number {
  return integerSetting(name, process.env[name], dflt, min);
}

const workerPrivateKey = req('WORKER_PRIVATE_KEY');
const expectedWorker = req('WORKER_SIGNER_ADDRESS');
let workerAddress: string;
try { workerAddress = new ethers.Wallet(workerPrivateKey).address; }
catch { throw new Error('WORKER_SIGNER_CONFIGURATION_INVALID'); }
if (!ethers.isAddress(expectedWorker) || expectedWorker === ethers.ZeroAddress || expectedWorker.toLowerCase() !== workerAddress.toLowerCase()) {
  throw new Error('WORKER_SIGNER_ROLE_MISMATCH');
}

export const cfg = {
  sourceRpc:     req('SOURCE_CHAIN_RPC_URL'),
  hubRpc:        req('CREDITCOIN_RPC_URL'),
  proofBuilder:  req('PROOF_BUILDER_URL').replace(/\/+$/, ''),
  privateKey:    workerPrivateKey,
  sourceAddress: req('SOURCE_CONTRACT_ADDRESS'),
  ascAddress:    req('ASC_CONTRACT_ADDRESS'),
  chainKey:      num('SOURCE_CHAIN_KEY', 1, 1),

  /// How far behind head a block must be before we treat it as final.
  /// Keeps a transaction that a reorg will erase from becoming a job.
  confirmations: num('WORKER_CONFIRMATIONS', 4, 1),
  hubConfirmations: num('WORKER_HUB_CONFIRMATIONS', 6, 1),
  /// Maximum block span per scan, to stay under public RPC eth_getLogs limits
  scanChunk:     num('WORKER_SCAN_CHUNK', 500, 1),
  /// Poll interval
  pollMs:        num('WORKER_POLL_MS', 12_000, 1),
  /// Concurrent jobs, so one eight-minute attestation wait does not block the others
  concurrency:   num('WORKER_CONCURRENCY', 8, 1),
  /// Attempts before a job is declared permanently failed
  maxAttempts:   num('WORKER_MAX_ATTEMPTS', 8, 1),
  statePath:     process.env.WORKER_STATE_PATH ?? 'state/worker.json',
  /// Explicit verified source deployment/replay start block; no current-head fallback.
  startBlock:    num('WORKER_START_BLOCK', 0, 1),
  health: workerHealthSettings(process.env.WORKER_HEALTH_PORT, process.env.WORKER_HEALTH_MAX_SCAN_AGE_MS),
};
