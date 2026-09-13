import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ListBackedAmlEngine } from './engine.js';
import { loadHistoricalLists, loadLists } from './loader.js';
import { ENGINE_VERSION } from './normalize.js';
import {
  assertHoldoutThresholds,
  evaluateHoldout,
  type HoldoutDataset,
  type HoldoutThresholdPolicy,
} from './holdout-evaluation.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

const datasetPath = option('--dataset');
const policyPath = option('--policy');
const outputPath = option('--out');
const historical = process.argv.includes('--historical');
if (!datasetPath || !policyPath || !outputPath) {
  throw new Error('usage: npm run eval:aml:holdout -- --dataset <approved.json> --policy <thresholds.json> --out <report.json> [--historical]');
}

const dataset = JSON.parse(readFileSync(resolve(datasetPath), 'utf8')) as HoldoutDataset;
const policy = JSON.parse(readFileSync(resolve(policyPath), 'utf8')) as HoldoutThresholdPolicy;
let engine: ListBackedAmlEngine;
let sourceSha256: Record<string, string>;
if (historical) {
  const lists = await loadHistoricalLists();
  sourceSha256 = lists.sourceSha256;
  engine = new ListBackedAmlEngine({ entries: lists.entries, listVersions: lists.listVersions,
    evidenceKey: 'holdout-evaluation-output-does-not-contain-subject-evidence', keyId: 'holdout-evaluation' });
} else {
  const lists = await loadLists('data/raw', 'screen');
  sourceSha256 = lists.sourceSha256;
  engine = new ListBackedAmlEngine({ entries: lists.entries, listVersions: lists.listVersions,
    evidenceKey: 'holdout-evaluation-output-does-not-contain-subject-evidence', keyId: 'holdout-evaluation',
    provenance: lists.provenance, maxAgeHours: lists.maxAgeHours });
}
const report = await evaluateHoldout(dataset, engine, {
  engineVersion: ENGINE_VERSION,
  sourceSha256,
}, policy);

// Apply the gate before publishing a success-looking report. A failed run exits nonzero and writes nothing.
assertHoldoutThresholds(report);
const absoluteOutput = resolve(outputPath);
mkdirSync(dirname(absoluteOutput), { recursive: true });
writeFileSync(absoluteOutput, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({
  status: 'PASS',
  output: absoluteOutput,
  reportFingerprint: report.reportFingerprint,
  independenceMetadataComplete: report.independenceMetadataComplete,
  independenceMetadataGaps: report.independenceMetadataGaps,
  caveat: 'Dataset provenance fields are self-declared inputs; this command is not independent approval.',
  warning: historical ? 'Historical list snapshot; not an issuance or production-freshness result.' : undefined,
}, null, 2));
