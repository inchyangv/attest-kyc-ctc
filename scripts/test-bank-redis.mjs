import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const name = `proofmark-bank-test-${randomUUID()}`;
// Known Redis 7.4.9 image; no port exposure, host mount, production credential or external network.
const image = 'redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99';
let created = false;
try {
  await exec('docker', ['run', '--rm', '--detach', '--network', 'none', '--name', name, image], { timeout: 120_000 });
  created = true;
  await exec('docker', ['exec', name, 'redis-cli', 'PING']);
  const tests = process.argv.slice(2);
  if (tests.some(path => !/^test\/[a-z0-9-]+\.integration\.ts$/.test(path))) throw new Error('expected repository integration test paths');
  const child = spawn(process.execPath, ['--import', 'tsx', '--test', ...(tests.length ? tests : ['test/bank-redis.integration.ts'])], {
    stdio: 'inherit', env: { ...process.env, TEST_REDIS_CONTAINER: name },
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} finally {
  if (created) await exec('docker', ['stop', '--time', '2', name]);
}
