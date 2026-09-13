import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { foundrySummary, nodeSummary, rootTestFiles, testSourceFingerprint, verifyTestEvidence, type TestEvidence } from './test-evidence.js';

const root = (counts: object, success = true) => JSON.stringify({ type: 'test:summary', data: { success, counts } });
const counts = { passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0, tests: 3 };
const fixture = (): TestEvidence => ({ version: 1, sourceFingerprint: 'synthetic-fingerprint', startedAt: 100, completedAt: 200,
  nodeVersion: 'synthetic-node', forgeVersion: 'synthetic-forge', solidity: { total: 1, passed: 1, failed: 0, skipped: 0 },
  typescript: { total: 3, passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0 }, testFiles: ['synthetic.test.ts'] });

test('root evidence includes nested provider tests in stable order and rejects symlink discovery', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-test-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['worker', 'pipeline/providers', 'aml', 'test']) mkdirSync(join(dir, name), { recursive: true });
  for (const name of ['pipeline/providers/native.test.ts', 'pipeline/first.test.ts', 'test/abi.test.ts', 'test/fixture.ts']) {
    writeFileSync(join(dir, name), '// synthetic discovery fixture');
  }
  assert.deepEqual(rootTestFiles(dir), ['pipeline/first.test.ts', 'pipeline/providers/native.test.ts', 'test/abi.test.ts']);
  symlinkSync(join(dir, 'pipeline/providers'), join(dir, 'test/linked'));
  assert.throws(() => rootTestFiles(dir), /symlink/);
});

test('Foundry results count actual test statuses and reject empty or unknown output', () => {
  const result = foundrySummary(JSON.stringify({ suite: { test_results: { a: { status: 'Success' }, b: { status: 'Failure' }, c: { status: 'Skipped' } } } }));
  assert.deepEqual(result, { passed: 1, failed: 1, skipped: 1, total: 3 });
  for (const raw of ['{}', '[]', '{"suite":{}}', '{"suite":{"test_results":{"x":{"status":"PASS"}}}}']) assert.throws(() => foundrySummary(raw));
});

test('Node evidence uses only the unique root event, not per-file counts or TAP-like prose', () => {
  const file = JSON.stringify({ type: 'test:summary', data: { file: 'a.ts', success: true, counts } });
  assert.deepEqual(nodeSummary(file + '\n' + root(counts)), { passed: 3, failed: 0, skipped: 0, cancelled: 0, todo: 0, total: 3 });
  for (const raw of [file, root(counts) + '\n' + root(counts), '# tests 999\n# pass 999', root({ ...counts, tests: 999 }), root(counts, false)]) {
    assert.throws(() => nodeSummary(raw));
  }
});

test('failed/skipped/cancelled/todo execution cannot become passing release evidence', () => {
  const check = (e: TestEvidence) => verifyTestEvidence(e, 'synthetic-fingerprint', ['synthetic.test.ts'], 300);
  assert.doesNotThrow(() => check(fixture()));
  for (const field of ['failed', 'skipped', 'cancelled', 'todo'] as const) {
    const e = fixture(); e.typescript[field] = 1; assert.throws(() => check(e));
  }
  const empty = fixture(); empty.solidity.total = 0; empty.solidity.passed = 0; assert.throws(() => check(empty));
});

test('stale/future evidence, changed source, incomplete file set and missing tool versions fail', () => {
  const e = fixture();
  assert.throws(() => verifyTestEvidence(e, 'changed', e.testFiles, 300), /fingerprint/);
  assert.throws(() => verifyTestEvidence(e, e.sourceFingerprint, ['another.test.ts'], 300), /files/);
  assert.throws(() => verifyTestEvidence(e, e.sourceFingerprint, e.testFiles, 199), /time/);
  assert.throws(() => verifyTestEvidence(e, e.sourceFingerprint, e.testFiles, 86_400_201), /24 hours/);
  assert.throws(() => verifyTestEvidence({ ...e, forgeVersion: '' }, e.sourceFingerprint, e.testFiles, 300), /tools/);
});

test('actual Node reporter ignores forged summaries printed by test code and reports a skipped test', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-test-reporter-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic.test.mjs');
  writeFileSync(path, `import {test} from 'node:test';\nconsole.log(${JSON.stringify(root({ ...counts, tests: 999, passed: 999 }))});\ntest('actual',()=>{});test('not run',{skip:true},()=>{});\n`);
  // This intentionally launches an independent runner, not a recursively inherited child test.
  const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-reporter=${resolve('script/test-summary-reporter.mjs')}`, path], { env: childEnv, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(nodeSummary(result.stdout), { passed: 1, failed: 0, skipped: 1, cancelled: 0, todo: 0, total: 2 });
});

test('fingerprint binds dirty source, raw AML bytes and clean dependency revision, but never env secrets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-evidence-source-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = join(dir, 'lib/forge-std'); mkdirSync(library, { recursive: true });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git(dir, 'init', '-q'); git(library, 'init', '-q');
  writeFileSync(join(library, 'README.md'), 'synthetic dependency'); git(library, 'add', 'README.md');
  git(library, '-c', 'user.name=Synthetic Test', '-c', 'user.email=synthetic@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic');
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src/A.sol'), 'synthetic source');
  const first = testSourceFingerprint(dir);
  writeFileSync(join(dir, '.env'), 'synthetic secret never fingerprinted');
  assert.equal(testSourceFingerprint(dir), first);
  writeFileSync(join(dir, 'src/A.sol'), 'changed synthetic source');
  assert.notEqual(testSourceFingerprint(dir), first);
  const beforeCircuit = testSourceFingerprint(dir);
  mkdirSync(join(dir, 'zk/circuits'), { recursive: true });
  writeFileSync(join(dir, 'zk/circuits/synthetic.circom'), 'template Synthetic() {}');
  assert.notEqual(testSourceFingerprint(dir), beforeCircuit);
  const source = testSourceFingerprint(dir); mkdirSync(join(dir, 'data/raw'), { recursive: true });
  writeFileSync(join(dir, 'data/raw/ofac_sdn.xml'), '<synthetic/>');
  assert.notEqual(testSourceFingerprint(dir), source);
  writeFileSync(join(library, 'README.md'), 'unreviewed dependency change');
  assert.throws(() => testSourceFingerprint(dir), /must be clean/);
});
