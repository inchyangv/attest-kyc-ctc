import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type JobState =
  | 'discovered'    // 소스 체인에서 발견, 아직 어테스트 안 됨
  | 'attested'      // 해당 블록이 어테스트됨
  | 'submitted'     // ASC 제출 완료
  | 'done'          // 확정
  | 'skipped'       // ASC 가 이미 처리한 쿼리 (가스 낭비 회피)
  | 'dead';         // 영구 실패 — 사람이 봐야 한다

export interface Job {
  txHash: string;
  blockNumber: number;
  action: number;
  eventName: string;
  logCount: number;
  state: JobState;
  attempts: number;
  lastError?: string;
  ascTxHash?: string;
  queryId?: string;
  discoveredAt: number;
  updatedAt: number;
}

interface Data {
  version: 1;
  /** 완전히 스캔이 끝난 마지막 소스 블록. 이 블록까지는 모든 작업이 영속화되어 있다. */
  cursor: number;
  jobs: Record<string, Job>;
}

/**
 * 파일 기반 영속 상태.
 *
 * ★ 존재 이유: 예제 워커는 `loanTracker` 를 메모리에만 두고 시작 블록을 `getBlockNumber()` 로 잡는다.
 *   재시작하면 추적 상태가 사라지고 다운타임 중 발생한 이벤트를 **영원히 놓친다**.
 *   (docs/02-loan-flow-analysis.md §7)
 *
 * 쓰기는 tmp 파일 → rename 으로 원자적으로 한다. 중간에 죽어도 반쪽 파일이 남지 않는다.
 */
export class Store {
  private data: Data;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Data;
      if (parsed.version !== 1) throw new Error(`알 수 없는 상태 파일 버전: ${parsed.version}`);
      this.data = parsed;
    } else {
      this.data = { version: 1, cursor: 0, jobs: {} };
    }
  }

  get cursor(): number { return this.data.cursor; }

  /** 커서는 해당 블록의 작업이 모두 영속화된 뒤에만 전진시킨다. */
  setCursor(block: number): void {
    if (block < this.data.cursor) return;   // 되돌리지 않는다
    this.data.cursor = block;
    this.flush();
  }

  has(txHash: string): boolean { return txHash in this.data.jobs; }
  get(txHash: string): Job | undefined { return this.data.jobs[txHash]; }

  add(job: Omit<Job, 'discoveredAt' | 'updatedAt'>): Job {
    const now = Date.now();
    const j: Job = { ...job, discoveredAt: now, updatedAt: now };
    this.data.jobs[j.txHash] = j;
    this.flush();
    return j;
  }

  update(txHash: string, patch: Partial<Job>): void {
    const j = this.data.jobs[txHash];
    if (!j) return;
    Object.assign(j, patch, { updatedAt: Date.now() });
    this.flush();
  }

  /** 아직 끝나지 않은 작업들 */
  pending(): Job[] {
    return Object.values(this.data.jobs).filter(
      (j) => j.state !== 'done' && j.state !== 'dead' && j.state !== 'skipped',
    );
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const j of Object.values(this.data.jobs)) out[j.state] = (out[j.state] ?? 0) + 1;
    return out;
  }

  private flush(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);   // 원자적 교체
  }
}
