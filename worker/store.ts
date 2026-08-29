import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export type JobState =
  | 'discovered'   // seen on the source chain, not yet attested
  | 'attested'   // the block is attested
  | 'submitted'   // submitted to the ASC
  | 'done'   // confirmed
  | 'skipped'   // the ASC already processed this query, so no gas was spent
  | 'dead';   // permanently failed, needs a human

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
  /** Last fully scanned source block. Every job up to here is persisted. */
  cursor: number;
  jobs: Record<string, Job>;
}

/**
 * File-backed persistent state.
 *
 * Why this exists: the example worker keeps `loanTracker` in memory and starts from
 * `getBlockNumber()`. A restart loses tracking and misses everything that happened while down.
 *   (docs/02-loan-flow-analysis.md §7)
 *
 * Writes go to a tmp file then rename, so a crash never leaves half a file.
 */
export class Store {
  private data: Data;

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Data;
      if (parsed.version !== 1) throw new Error(`unknown state file version: ${parsed.version}`);
      this.data = parsed;
    } else {
      this.data = { version: 1, cursor: 0, jobs: {} };
    }
  }

  get cursor(): number { return this.data.cursor; }

  /** Advance the cursor only once every job for that block is persisted. */
  setCursor(block: number): void {
    if (block < this.data.cursor) return;   // never rewind
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

  /** Jobs that have not finished */
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
    renameSync(tmp, this.path);   // atomic replace
  }
}
