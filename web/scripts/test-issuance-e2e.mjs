import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const name = `proofmark-bank-test-${randomUUID()}`;
let created = false;
try {
  await exec('docker', ['run', '--rm', '--detach', '--network', 'none', '--name', name,
    'redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99'], { timeout: 120000 });
  created = true;
  await exec('docker', ['exec', name, 'redis-cli', 'PING']);
  const child = spawn(process.execPath, ['--conditions=react-server', '--import', '../node_modules/tsx/dist/loader.mjs',
    '--test', 'tests/issuance-e2e.integration.mts'], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
    env: { ...process.env, TEST_REDIS_CONTAINER: name, TSX_TSCONFIG_PATH: 'tsconfig.json' } });
  process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally {
  if (created) await exec('docker', ['stop', '--time', '2', name]);
}
