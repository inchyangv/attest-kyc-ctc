import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListBackedAmlEngine } from './engine.js';
import { loadHistoricalLists } from './loader.js';
import {
  assertHoldoutThresholds,
  evaluateHoldout,
  type HoldoutDataset,
} from './holdout-evaluation.js';
import type { AmlEngine } from './types.js';

const dataset: HoldoutDataset = {
  schemaVersion: 1,
  datasetId: 'proofmark-t29-ci-canary',
  datasetVersion: '1',
  provenance: {
    classification: 'internal-synthetic',
    independentlyLabeled: false,
    holdoutFromDevelopment: false,
    labelOwner: 'Proofmark test fixture',
    labelBasis: 'Synthetic regression expectations authored with the matcher tests',
    containsPersonalData: false,
  },
  cases: [
    {
      id: 'latin-positive',
      subject: { fullName: 'Victor Sampleton', dateOfBirth: '1980-02-29', nationality: 'KR', residence: 'KR', walletAddress: '' },
      truth: 'POSITIVE',
      dimensions: { country: 'KR', script: 'Latin', listId: 'OFAC_SDN', entityType: 'individual' },
      labelBasis: 'Exact synthetic list entry with matching full DOB',
      investigationMs: 1_200,
    },
    {
      id: 'arabic-positive',
      subject: { fullName: 'عبدالرحمن منصوري', dateOfBirth: '1976-01-02', nationality: 'AE', residence: 'AE', walletAddress: '' },
      truth: 'POSITIVE',
      dimensions: { country: 'AE', script: 'Arabic', listId: 'UN_CONSOLIDATED', entityType: 'individual' },
      labelBasis: 'Exact synthetic list name with a deliberately conflicting DOB; expected manual REVIEW',
      investigationMs: 1_800,
    },
    {
      id: 'latin-negative',
      subject: { fullName: 'Zorvax Quenlith', dateOfBirth: '1991-05-20', nationality: 'US', residence: 'US', walletAddress: '' },
      truth: 'NEGATIVE',
      dimensions: { country: 'US', script: 'Latin', listId: 'NONE', entityType: 'individual' },
      labelBasis: 'Invented name absent from the two-entry synthetic corpus',
      investigationMs: 600,
    },
  ],
};

const entries = [
  { listId: 'OFAC_SDN' as const, entryId: 't29-latin', primaryName: 'Victor Sampleton', names: ['Victor Sampleton'], dobs: ['1980-02-29'], countries: ['KR'], programs: [], cryptoAddresses: [], type: 'individual' as const },
  { listId: 'UN_CONSOLIDATED' as const, entryId: 't29-arabic', primaryName: 'عبدالرحمن منصوري', names: ['عبدالرحمن منصوري'], dobs: ['1975-01-02'], countries: ['AE'], programs: [], cryptoAddresses: [], type: 'individual' as const },
];

const policy = {
  version: 'aml-holdout-gate-1',
  minimumCases: 3,
  maximumFalseNegativeRate: 0,
  maximumFalsePositiveRate: 0,
  maximumReviewRate: 1 / 3,
};

test('PM-T29-01: the evaluation gate rejects a deliberately all-ALLOW matcher', async () => {
  const engine = new ListBackedAmlEngine({ entries, listVersions: { OFAC_SDN: 1, UN_CONSOLIDATED: 1 }, evidenceKey: 't29-test-only' });
  const passing = await evaluateHoldout(dataset, engine, {
    engineVersion: 'aml-t29-canary',
    sourceSha256: { synthetic: 'a'.repeat(64) },
  }, policy);
  assert.doesNotThrow(() => assertHoldoutThresholds(passing, policy));
  assert.equal(passing.independenceMetadataComplete, false);
  assert.match(passing.independenceMetadataGaps.join(' '), /not independently labelled/i);
  assert.deepEqual({ block: passing.overall.block, review: passing.overall.review, allow: passing.overall.allow }, { block: 1, review: 1, allow: 1 });
  assert.deepEqual(passing.investigation, { reviewed: 1, reviewedWithTiming: 1, totalMs: 1_800, meanMs: 1_800, p50Ms: 1_800, p95Ms: 1_800 });
  assert.equal(passing.byScript.Arabic.truePositive, 1);
  assert.equal(passing.byCountry.US.trueNegative, 1);
  assert.equal(passing.byList.OFAC_SDN.block, 1);
  assert.match(passing.reportFingerprint, /^[0-9a-f]{64}$/);
  const redactedReport = JSON.stringify(passing);
  for (const privateValue of ['Victor Sampleton', 'عبدالرحمن منصوري', '1991-05-20']) assert.equal(redactedReport.includes(privateValue), false);

  const broken: AmlEngine = {
    listVersions: () => engine.listVersions(),
    screen: async subject => ({ ...(await engine.screen(subject)), decision: 'ALLOW', reviewReason: undefined, hits: [] }),
  };
  const sabotaged = await evaluateHoldout(dataset, broken, {
    engineVersion: 'deliberately-broken-all-allow',
    sourceSha256: { synthetic: 'a'.repeat(64) },
  }, policy);
  assert.equal(sabotaged.overall.falseNegative, 2);
  assert.throws(() => assertHoldoutThresholds(sabotaged, policy), /false-negative rate/);
});

test('versioned holdout CLI writes a source-bound redacted report and labels internal data as incomplete', async () => {
  const lists = await loadHistoricalLists();
  const listed = lists.entries.find(entry => entry.type === 'individual' && entry.dobs.length && entry.countries.length && entry.primaryName.split(/\s+/).length >= 2);
  assert.ok(listed, 'historical fixture needs one labelled positive');
  const directory = mkdtempSync(join(tmpdir(), 'proofmark-t29-'));
  try {
    const input = join(directory, 'dataset.json');
    const threshold = join(directory, 'policy.json');
    const output = join(directory, 'report.json');
    const cliDataset: HoldoutDataset = {
      schemaVersion: 1,
      datasetId: 'proofmark-t29-cli-canary',
      datasetVersion: '1',
      provenance: {
        classification: 'internal-synthetic', independentlyLabeled: false, holdoutFromDevelopment: false,
        labelOwner: 'Proofmark test fixture', labelBasis: 'One source-list self-match plus one invented negative',
        selectionProtocol: 'First eligible source entry in parser order; deterministic and not independent', containsPersonalData: false,
      },
      cases: [
        {
          id: 'source-self-positive',
          subject: { fullName: listed.primaryName, dateOfBirth: listed.dobs[0].length === 4 ? `${listed.dobs[0]}-01-01` : listed.dobs[0],
            nationality: listed.countries[0], residence: listed.countries[0], walletAddress: '' },
          truth: 'POSITIVE', dimensions: { country: listed.countries[0], script: 'SourceNative', listId: listed.listId, entityType: listed.type },
          labelBasis: 'The exact public source-list entry supplies the regression label',
        },
        {
          id: 'invented-negative',
          subject: { fullName: 'Zorvaxquendril T29cleanfixture', dateOfBirth: '1991-05-20', nationality: 'KR', residence: 'KR', walletAddress: '' },
          truth: 'NEGATIVE', dimensions: { country: 'KR', script: 'Latin', listId: 'NONE', entityType: 'individual' },
          labelBasis: 'Invented regression name; not an independently adjudicated customer',
        },
      ],
    };
    writeFileSync(input, JSON.stringify(cliDataset));
    writeFileSync(threshold, JSON.stringify({ ...policy, minimumCases: 2, maximumReviewRate: 1 }));
    execFileSync(process.execPath, ['--import', 'tsx', 'aml/holdout-eval.ts', '--dataset', input, '--policy', threshold, '--out', output, '--historical'],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30_000 });
    const report = JSON.parse(readFileSync(output, 'utf8')) as ReturnType<typeof JSON.parse>;
    assert.equal(report.overall.total, 2);
    assert.equal(report.overall.falseNegative, 0);
    assert.equal(report.overall.falsePositive, 0);
    assert.equal(report.independenceMetadataComplete, false);
    assert.equal(JSON.stringify(report).includes(listed.primaryName), false);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
