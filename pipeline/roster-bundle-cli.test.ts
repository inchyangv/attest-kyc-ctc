import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, statSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleFixture } from '../test/fixtures/roster-bundle.js';
import { stageRosterBundleReplicas } from './roster-bundle-availability.js';

test('actual bundle CLI requires disclosure acknowledgement, creates immutable files and serves offline after origin loss', t => {
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-bundle-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { record, scope } = bundleFixture();
  const recordPath = join(dir, 'record.json'), deploymentPath = join(dir, 'deployment.json');
  writeFileSync(recordPath, JSON.stringify(record));
  writeFileSync(deploymentPath, JSON.stringify({ network: { sourceChainId: scope.sourceChainId, hubChainId: scope.hubChainId }, sourceChainKey: scope.sourceChainKey,
    contracts: { ComplianceSource: scope.source, ProofmarkASC: scope.asc, ProofmarkRegistry: scope.registry } }));
  const run = (...args: string[]) => execFileSync(process.execPath, ['--import', 'tsx', 'script/roster-bundle.ts', ...args],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.throws(() => run('export', recordPath, deploymentPath, join(dir, 'replica')));
  const result = JSON.parse(run('export', recordPath, deploymentPath, join(dir, 'replica'), '--ack-linkable-roster'));
  const before = readFileSync(result.file);
  assert.equal(statSync(result.file).mode & 0o777, 0o600);
  assert.throws(() => run('export', recordPath, deploymentPath, join(dir, 'replica'), '--ack-linkable-roster'));
  assert.deepEqual(readFileSync(result.file), before);
  unlinkSync(recordPath); // synthetic publisher source only; the independent export remains
  const proof = JSON.parse(run('proof', result.file, result.contentHash, record.entries[0].subject));
  assert.equal(proof.kind, 'inclusion'); assert.equal(proof.chainValidation, 'not-performed');
  assert.throws(() => run('proof', result.file, '0'.repeat(64), record.entries[0].subject));
  const staged = stageRosterBundleReplicas(record, scope, [join(dir, 'seed-a'), join(dir, 'seed-b')]);
  const recovered = JSON.parse(run('recover-seed', staged.seedFiles[1], staged.seedHash, String(record.publishedAt),
    join(dir, 'recovered'), '--ack-linkable-roster'));
  assert.equal(statSync(recovered.file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(run('proof', recovered.file, recovered.contentHash, record.entries[0].subject)).kind, 'inclusion');
});
