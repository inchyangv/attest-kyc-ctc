import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWorkerEnvironmentFile } from '../pipeline/worker-env.js';

if (process.argv.length !== 3) throw new Error('usage: check-worker-env <worker-env-file>');
const names = checkWorkerEnvironmentFile(process.argv[2], resolve(fileURLToPath(new URL('../.env', import.meta.url))));
console.log(JSON.stringify({ status: 'WORKER_ENV_VERIFIED', names }));
