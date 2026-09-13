/** Read-only scheduled-run monitor. Exit 0 is local run evidence, never alert delivery or chain enforcement. */
import 'dotenv/config';
import { monitorRescreenSchedule, readRescreenRunState } from '../pipeline/rescreen-schedule.js';

function required(name: string): string {
  const value = process.env[name]?.trim(); if (!value) throw new Error('MISSING_RESCREEN_MONITOR_CONFIGURATION'); return value;
}
function milliseconds(name: string): number {
  const raw = required(name), seconds = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(seconds * 1000) || seconds <= 0) throw new Error('INVALID_RESCREEN_MONITOR_CONFIGURATION');
  return seconds * 1000;
}
try {
  if (process.argv.length !== 2) throw new Error('MONITOR_ACCEPTS_NO_ARGUMENTS');
  const limits = { scheduleId: required('RESCREEN_SCHEDULE_ID'), scheduleIntervalMs: milliseconds('RESCREEN_SCHEDULE_INTERVAL_SECONDS'),
    maxRunMs: milliseconds('MONITOR_RESCREEN_RUN_SECONDS'), sanctionsSnapshotId: required('SANCTIONS_EXPECTED_SNAPSHOT_ID') };
  const result = monitorRescreenSchedule(readRescreenRunState(required('RESCREEN_RUN_STATE_PATH')), limits);
  console.log(JSON.stringify(result)); if (result.findingCount) process.exitCode = 1;
} catch { console.error('RESCREEN_MONITOR_UNAVAILABLE'); process.exitCode = 2; }
