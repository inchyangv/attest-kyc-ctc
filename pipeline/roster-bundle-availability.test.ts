import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleFixture } from '../test/fixtures/roster-bundle.js';
import { loadRosterBundle } from './roster-bundle.js';
import {
  finalizeRosterBundleReplicas,
  stageRosterBundleReplicas,
} from './roster-bundle-availability.js';

test('PM-T19-01 publication readiness requires recoverable replicas before publisher origin loss', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'proofmark-roster-availability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const origin = join(dir, 'publisher-record.json');
  const replicas = [join(dir, 'replica-a'), join(dir, 'replica-b')];
  const { record, scope } = bundleFixture();
  fs.writeFileSync(origin, JSON.stringify(record));

  assert.throws(
    () => stageRosterBundleReplicas(record, scope, [replicas[0]]),
    /at least two distinct replica directories/,
  );

  const staged = stageRosterBundleReplicas(record, scope, replicas);
  assert.equal(staged.replicaCount, 2);
  for (const file of staged.seedFiles) {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(file), fs.readFileSync(staged.seedFiles[0]));
  }

  fs.unlinkSync(origin);
  const finalized = finalizeRosterBundleReplicas(staged, record.publishedAt);
  assert.equal(finalized.replicaCount, 2);
  assert.equal(finalized.files.length, 2);

  fs.rmSync(replicas[0], { recursive: true });
  const surviving = fs.readFileSync(finalized.files[1]);
  const proof = loadRosterBundle(surviving, finalized.contentHash).proof(record.entries[0].subject);
  assert.equal(proof.kind, 'inclusion');
  assert.equal(proof.root, record.root);
});

test('replica finalization fails closed when a staged copy disappeared or was changed', t => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'proofmark-roster-availability-drift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const replicas = [join(dir, 'replica-a'), join(dir, 'replica-b')];
  const { record, scope } = bundleFixture();
  const staged = stageRosterBundleReplicas(record, scope, replicas);
  fs.unlinkSync(staged.seedFiles[1]);
  assert.throws(() => finalizeRosterBundleReplicas(staged, record.publishedAt), /replica seed unavailable/);
  assert.equal(fs.readdirSync(replicas[0]).some(name => name.endsWith('.json') && !name.endsWith('.seed.json')), false);
});
