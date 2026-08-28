import { ProofmarkWorker } from './worker.js';
import { log } from './log.js';

const worker = new ProofmarkWorker();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info(`${sig} 수신 — 진행 중 작업을 마치고 종료합니다`);
    worker.stop();
  });
}

worker.run().catch((e) => {
  log.error('워커 기동 실패:', e?.message ?? e);
  process.exit(1);
});
