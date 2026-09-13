import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentGeneration } from './loader.js';
import { refreshSnapshot } from './snapshot-store.js';
import { FATF } from './jurisdiction.js';
import { SOURCES } from './provenance.js';
import type { ListId } from './types.js';
import { SANCTIONS_RUNTIME_SCOPES, assessSanctionsRollout, createSanctionsRolloutPlan, type SanctionsRuntimeObservation } from './rollout.js';

const xml = (id: ListId) => Buffer.from(id === 'OFAC_SDN' ? '<sdnList><sdnEntry><uid>1</uid><lastName>Fixture</lastName></sdnEntry></sdnList>'
  : id === 'UN_CONSOLIDATED' ? '<CONSOLIDATED_LIST><ENTITY><DATAID>2</DATAID><FIRST_NAME>Fixture</FIRST_NAME></ENTITY></CONSOLIDATED_LIST>'
    : '<export><sanctionEntity logicalId="3"><nameAlias wholeName="Fixture"/></sanctionEntity></export>');

test('mixed or missing fleet observations and an unobserved rescreen trigger fail the local rollout gate', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proofmark-rollout-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = Date.parse(FATF.verifiedAt) + 1;
  await refreshSnapshot(root, async id => ({ bytes: xml(id), fetchedAt: new Date(now).toISOString(), effectiveUrl: SOURCES[id].url, httpLastModified: null }), () => now);
  const index = readFileSync(join(currentGeneration(root), 'sanctions-index.json.gz'));
  const policyEnv = { SANCTIONS_SCREEN_MAX_AGE_HOURS: '72', SANCTIONS_ISSUANCE_MAX_AGE_HOURS: '24',
    SANCTIONS_RESCREEN_MAX_AGE_HOURS: '12', SANCTIONS_EPOCH_MAX_AGE_HOURS: '6' };
  assert.throws(() => createSanctionsRolloutPlan(index, null, {}, now), /PURPOSE_POLICY_REQUIRED/);
  const plan = createSanctionsRolloutPlan(index, '1'.repeat(64), policyEnv, now);
  const observation = (runtime: typeof SANCTIONS_RUNTIME_SCOPES[number]): SanctionsRuntimeObservation => ({
    version: 1, runtime, releaseId: plan.releaseId, snapshotId: plan.snapshotId,
    indexSha256: runtime === 'worker-relay' ? null : plan.indexSha256, fatfSnapshotId: plan.fatfSnapshotId,
    freshnessHours: plan.freshnessHours, observedAt: new Date(now).toISOString(),
  });
  const incomplete = assessSanctionsRollout(plan, [observation('web-screen'), { ...observation('web-issuance'), snapshotId: '2'.repeat(64) }], null, now);
  assert.equal(incomplete.status, 'ATTENTION_REQUIRED');
  assert.ok(incomplete.findings.RUNTIME_MISSING); assert.ok(incomplete.findings.RUNTIME_RELEASE_MISMATCH);
  assert.equal(incomplete.findings.RESCREEN_TRIGGER_NOT_OBSERVED, 1);

  const complete = assessSanctionsRollout(plan, SANCTIONS_RUNTIME_SCOPES.map(observation), {
    version: 2, sanctionsSnapshotId: plan.snapshotId, phase: 'running',
  }, now);
  assert.equal(complete.status, 'LOCAL_EVIDENCE_COMPLETE'); assert.equal(complete.findingCount, 0);
  assert.equal(complete.alertDelivery, 'NOT_CONFIGURED'); assert.equal(complete.deployment, 'NOT_PERFORMED');
});
