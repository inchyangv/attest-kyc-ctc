import { openSync, writeFileSync, closeSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Single-host process ownership only. No TTL: a crashed owner requires verified recovery,
 * never an automatic takeover while its signed transaction outcome may still be unknown. */
export function acquireWorkerLease(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch { throw new Error('WORKER_LEASE_UNAVAILABLE: inspect existing owner before recovery'); }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); }
  catch { closeSync(fd); unlinkSync(path); throw new Error('WORKER_LEASE_WRITE_FAILED'); }
  let released = false;
  return () => { if (!released) { released = true; closeSync(fd); unlinkSync(path); } };
}
