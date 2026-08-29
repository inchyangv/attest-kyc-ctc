import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`environment variable ${name} is not set (check .env)`);
  return v;
}
function num(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`environment variable ${name} is not a number: ${v}`);
  return n;
}

export const cfg = {
  sourceRpc:     req('SOURCE_CHAIN_RPC_URL'),
  hubRpc:        req('CREDITCOIN_RPC_URL'),
  proofBuilder:  req('PROOF_BUILDER_URL').replace(/\/+$/, ''),
  privateKey:    req('DEPLOYER_PRIVATE_KEY'),
  sourceAddress: req('SOURCE_CONTRACT_ADDRESS'),
  ascAddress:    req('ASC_CONTRACT_ADDRESS'),
  chainKey:      num('SOURCE_CHAIN_KEY', 1),

  /// How far behind head a block must be before we treat it as final.
  /// Keeps a transaction that a reorg will erase from becoming a job.
  confirmations: num('WORKER_CONFIRMATIONS', 4),
  /// Maximum block span per scan, to stay under public RPC eth_getLogs limits
  scanChunk:     num('WORKER_SCAN_CHUNK', 500),
  /// Poll interval
  pollMs:        num('WORKER_POLL_MS', 12_000),
  /// Concurrent jobs, so one eight-minute attestation wait does not block the others
  concurrency:   num('WORKER_CONCURRENCY', 8),
  /// Attempts before a job is declared permanently failed
  maxAttempts:   num('WORKER_MAX_ATTEMPTS', 8),
  statePath:     process.env.WORKER_STATE_PATH ?? 'state/worker.json',
  /// Which block to start from on a cold start. 0 means current head.
  startBlock:    num('WORKER_START_BLOCK', 0),
};
