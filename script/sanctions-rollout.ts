import 'dotenv/config';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { currentGeneration } from '../aml/loader.js';
import { atomicFile } from '../aml/snapshot-store.js';
import { assessSanctionsRollout, createSanctionsRolloutPlan, type SanctionsRolloutPlan, type SanctionsRuntimeObservation } from '../aml/rollout.js';
import { readRescreenRunState } from '../pipeline/rescreen-schedule.js';

const bounded = <T>(path: string): T => {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 2 || stat.size > 1024 * 1024) throw new Error('SANCTIONS_ROLLOUT_INPUT_INVALID');
  return JSON.parse(readFileSync(path, 'utf8')) as T;
};
const args = process.argv.slice(2);
if (args[0] === 'plan' && (args.length === 2 || args.length === 3)) {
  const previous = args[2] ?? null;
  const index = readFileSync(join(currentGeneration('data/raw'), 'sanctions-index.json.gz'));
  const plan = createSanctionsRolloutPlan(index, previous);
  atomicFile(args[1], JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'SANCTIONS_ROLLOUT_PLAN_WRITTEN', releaseId: plan.releaseId, snapshotId: plan.snapshotId, path: args[1] }));
} else if (args[0] === 'verify' && args.length === 4) {
  const plan = bounded<SanctionsRolloutPlan>(args[1]);
  const observations = bounded<SanctionsRuntimeObservation[]>(args[2]);
  const state = readRescreenRunState(args[3]);
  const result = assessSanctionsRollout(plan, observations, state);
  console.log(JSON.stringify(result));
  if (result.findingCount) process.exitCode = 1;
} else {
  throw new Error('usage: sanctions:rollout plan <output> [previous-snapshot-id] | verify <plan> <runtime-observations> <rescreen-run-state>');
}
