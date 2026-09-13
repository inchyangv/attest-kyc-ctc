import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const RESCREEN_RUN_STATE_MAX_BYTES = 64 * 1024;

type RunningState = { version: 2; scheduleId: string; sanctionsSnapshotId: string; phase: 'running'; scheduleIntervalMs: number; startedAt: number };
type FinishedState = { version: 2; scheduleId: string; sanctionsSnapshotId: string; phase: 'succeeded'; scheduleIntervalMs: number; startedAt: number;
  completedAt: number; due: number; blocked: number; sourceConfirmed: number; pending: number };
type FailedState = { version: 2; scheduleId: string; sanctionsSnapshotId: string; phase: 'failed'; scheduleIntervalMs: number; startedAt: number; completedAt: number };
export type RescreenRunState = RunningState | FinishedState | FailedState;
export interface RescreenScheduleLimits { scheduleId: string; sanctionsSnapshotId: string; scheduleIntervalMs: number; maxRunMs: number }

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const scheduleId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const snapshotId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function demand(ok: unknown): asserts ok { if (!ok) throw new Error('INVALID_RESCREEN_RUN_STATE'); }

function validate(value: unknown): RescreenRunState {
  demand(object(value) && value.version === 2 && scheduleId(value.scheduleId) && snapshotId(value.sanctionsSnapshotId)
    && integer(value.scheduleIntervalMs) && value.scheduleIntervalMs > 0 && integer(value.startedAt));
  const common = ['phase', 'sanctionsSnapshotId', 'scheduleId', 'scheduleIntervalMs', 'startedAt', 'version'];
  if (value.phase === 'running') {
    demand(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(common.sort()));
  } else if (value.phase === 'failed') {
    demand(integer(value.completedAt) && value.completedAt >= value.startedAt);
    demand(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...common, 'completedAt'].sort()));
  } else if (value.phase === 'succeeded') {
    demand(integer(value.completedAt) && value.completedAt >= value.startedAt && integer(value.due) && integer(value.blocked)
      && value.blocked <= value.due && integer(value.sourceConfirmed) && integer(value.pending));
    demand(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...common, 'completedAt', 'due', 'blocked', 'sourceConfirmed', 'pending'].sort()));
  } else demand(false);
  return structuredClone(value) as RescreenRunState;
}

/** Existing bounded regular file only. Missing evidence is unavailable, never a healthy empty schedule. */
export function readRescreenRunState(path: string): RescreenRunState {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); demand(stat.isFile() && stat.size > 0 && stat.size <= RESCREEN_RUN_STATE_MAX_BYTES);
    const chunks: Buffer[] = []; let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(4096, RESCREEN_RUN_STATE_MAX_BYTES + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count; demand(total <= RESCREEN_RUN_STATE_MAX_BYTES); chunks.push(chunk.subarray(0, count));
    }
    return validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total))));
  } finally { closeSync(fd); }
}

/** Durable single-runner heartbeat/result. It contains counts and an opaque scope only, never cases, keys or provider errors. */
export function writeRescreenRunState(path: string, value: RescreenRunState): void {
  const state = validate(value), bytes = JSON.stringify(state) + '\n';
  demand(Buffer.byteLength(bytes) <= RESCREEN_RUN_STATE_MAX_BYTES);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file: number | undefined, directory: number | undefined;
  try {
    file = openSync(temporary, 'wx', 0o600); writeFileSync(file, bytes); fsyncSync(file); closeSync(file); file = undefined;
    renameSync(temporary, path);
    directory = openSync(dirname(path), 'r'); fsyncSync(directory); closeSync(directory); directory = undefined;
  } catch { throw new Error('RESCREEN_RUN_STATE_WRITE_UNCONFIRMED'); }
  finally {
    if (file !== undefined) { try { closeSync(file); } catch {} }
    if (directory !== undefined) { try { closeSync(directory); } catch {} }
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch {}
  }
}

/** Read-only run-missed/stalled result. This does not inspect the vault, chains or alert delivery. */
export function monitorRescreenSchedule(value: unknown, limits: RescreenScheduleLimits, now = Date.now()) {
  demand(integer(now) && scheduleId(limits.scheduleId) && snapshotId(limits.sanctionsSnapshotId)
    && integer(limits.scheduleIntervalMs) && limits.scheduleIntervalMs > 0
    && integer(limits.maxRunMs) && limits.maxRunMs > 0);
  const state = validate(value);
  demand(state.scheduleId === limits.scheduleId && state.sanctionsSnapshotId === limits.sanctionsSnapshotId
    && state.scheduleIntervalMs === limits.scheduleIntervalMs && state.startedAt <= now);
  const counts: Record<string, number> = {};
  const add = (code: string) => { counts[code] = 1; };
  if (state.phase === 'running') {
    if (now - state.startedAt >= limits.maxRunMs) add('RUN_STALLED');
  } else {
    demand(state.completedAt <= now);
    if (state.phase === 'failed') add('LAST_RUN_FAILED');
    else {
      if (state.pending > 0) add('LAST_RUN_PENDING');
      if (now - state.startedAt >= limits.scheduleIntervalMs) add('RUN_MISSED');
    }
  }
  const findingCount = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return { version: 2, observedAt: now, scope: 'rescreen-schedule-run-state', scheduleId: state.scheduleId,
    sanctionsSnapshotId: state.sanctionsSnapshotId,
    runnerState: state.phase, status: findingCount ? 'ATTENTION_REQUIRED' : 'NO_LOCAL_FINDINGS',
    alertDelivery: 'NOT_CONFIGURED', currentEnforcement: 'NOT_CHECKED', vaultBacklog: 'NOT_CHECKED',
    limits: { scheduleIntervalMs: limits.scheduleIntervalMs, maxRunMs: limits.maxRunMs },
    lastStartedAt: state.startedAt, ...(state.phase === 'running' ? {} : { lastCompletedAt: state.completedAt }),
    findingCount, counts };
}
