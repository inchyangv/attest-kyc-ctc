import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkWorkerEnvironmentFile, WorkerEnvironmentError } from './worker-env.js';

const SECRET = 'PRIVATE-DEPLOYER-MUST-NEVER-REACH-WORKER';
const valid = [
  'SOURCE_CHAIN_RPC_URL=https://source.invalid', 'CREDITCOIN_RPC_URL=https://hub.invalid',
  'PROOF_BUILDER_URL=https://proof.invalid', 'WORKER_PRIVATE_KEY=synthetic-worker-only',
  `WORKER_SIGNER_ADDRESS=0x${'33'.repeat(20)}`,
  `SOURCE_CONTRACT_ADDRESS=0x${'11'.repeat(20)}`, `ASC_CONTRACT_ADDRESS=0x${'22'.repeat(20)}`,
  'WORKER_START_BLOCK=1',
].join('\n');
function fixture(t: { after: (fn: () => void) => void }, body = valid) {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-worker-env-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'worker.env'); writeFileSync(path, body, { mode: 0o600 }); return { dir, path };
}

test('worker deployment accepts only a private, minimum-role environment file', t => {
  const f = fixture(t); const names = checkWorkerEnvironmentFile(f.path, join(f.dir, '.env'));
  assert.deepEqual(names, ['ASC_CONTRACT_ADDRESS', 'CREDITCOIN_RPC_URL', 'PROOF_BUILDER_URL', 'SOURCE_CHAIN_RPC_URL',
    'SOURCE_CONTRACT_ADDRESS', 'WORKER_PRIVATE_KEY', 'WORKER_SIGNER_ADDRESS', 'WORKER_START_BLOCK']);
});

test('PM-T23-01 rejects a broad deployment environment before a deployer secret can reach the worker', t => {
  const f = fixture(t, `${valid}\nDEPLOYER_PRIVATE_KEY=${SECRET}`);
  assert.throws(() => checkWorkerEnvironmentFile(f.path), (error: unknown) => error instanceof WorkerEnvironmentError
    && error.code === 'WORKER_ENV_KEY_FORBIDDEN' && !error.message.includes(SECRET));
  const loose = fixture(t); chmodSync(loose.path, 0o640);
  assert.throws(() => checkWorkerEnvironmentFile(loose.path), (error: unknown) => error instanceof WorkerEnvironmentError
    && error.code === 'WORKER_ENV_FILE_UNSAFE');
});
