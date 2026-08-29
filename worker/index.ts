import { ProofmarkWorker } from './worker.js';
import { log } from './log.js';

const worker = new ProofmarkWorker();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} received. Finishing in-flight work, then exiting.`);
    worker.stop();
  });
}

worker.run().catch((e) => {
  log.error('워커 기동 실패:', e?.message ?? e);
  process.exit(1);
});
