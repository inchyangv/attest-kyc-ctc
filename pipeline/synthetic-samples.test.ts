import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requireSyntheticSampleMode, syntheticProfile, SYNTHETIC_SCENARIOS } from './synthetic-samples.js';
import { DemoIdDocumentVendor, DemoBankAccountVendor } from './adapters/demo.js';
import { KrAdapter } from './adapters/kr.js';
import { MockAmlEngine } from './aml.js';
import { runIssuance } from './issue.js';
import { SYNTHETIC_INDIVIDUAL_NONFACE_POLICY } from './identity-policy.js';
import type { EvidenceStep } from './evidence.js';
import { readIndex } from '../aml/index-format.js';
import { ListBackedAmlEngine } from '../aml/engine.js';

test('synthetic profiles are explicit fictional fixtures, validated scenarios and independent copies', () => {
  const p = syntheticProfile('success'); p.doc.fullName = 'modified';
  assert.equal(syntheticProfile('success').doc.fullName, 'PROOFMARK SAMPLE PERSON');
  assert.throws(() => syntheticProfile('unknown' as 'success'));
  for (const scenario of SYNTHETIC_SCENARIOS) {
    const sample = syntheticProfile(scenario); assert.match(sample.doc.fullName, /SAMPLE/);
    assert.equal(sample.doc.rrn, '0001010000001'); assert.match(sample.bank.accountNumber, /^0{8}/);
  }
});

test('sample requests require both exact built-in non-live vendors and explicit demo mode', () => {
  const id = new DemoIdDocumentVendor(0), bank = new DemoBankAccountVendor(0);
  for (const requested of [true, '1']) requireSyntheticSampleMode(requested, true, id, bank);
  for (const requested of [false, 1, 'true', '0', {}, []]) assert.throws(() => requireSyntheticSampleMode(requested, true, id, bank));
  assert.throws(() => requireSyntheticSampleMode(true, false, id, bank));
  for (const vendor of [null, { name: 'codef:id', live: false }, { name: 'demo:id', live: true }]) {
    assert.throws(() => requireSyntheticSampleMode(true, true, vendor, bank));
  }
  for (const vendor of [null, { name: 'openbanking:test', live: false }, { name: 'demo:bank', live: true }]) {
    assert.throws(() => requireSyntheticSampleMode(true, true, id, vendor));
  }
  requireSyntheticSampleMode(undefined, false, null, null);
});

test('preset document rejection and account mismatch exercise the actual demo adapter rules', async () => {
  const adapter = new KrAdapter(new DemoIdDocumentVendor(0), new DemoBankAccountVendor(0), { sandboxBits: true });
  for (const scenario of SYNTHETIC_SCENARIOS) {
    const p = syntheticProfile(scenario);
    const doc = await adapter.verifyIdDocument({ ...p.doc, docType: p.docType, image: new Uint8Array([1, 2, 3]) });
    assert.equal(doc.kind === 'verified' && doc.authentic, scenario !== 'document-rejected');
    const bank = await adapter.lookupHolder({ ...p.bank, birthDate: p.doc.birthDate.slice(2), declaredName: p.doc.fullName });
    assert.equal(bank.matches, scenario !== 'holder-mismatch');
  }
});

test('matching sample goes through the real issuance pipeline but remains sandbox with explicit mock AML', async () => {
  const p = syntheticProfile('success'); const idVendor = new DemoIdDocumentVendor(0), bankVendor = new DemoBankAccountVendor(0);
  const id = await idVendor.verify({ ...p.doc, docType: p.docType, image: new Uint8Array([1, 2, 3]) });
  assert.equal(id.kind, 'verified'); if (id.kind !== 'verified') return;
  const out = await runIssuance({ wallet: '0x' + 'ab'.repeat(20),
    declared: { fullName: p.doc.fullName, dateOfBirth: '2000-01-01', ...p.country }, walletControlProven: true,
    idDocument: id, bankAccount: { bankCode: p.bank.bankCode, holderName: p.doc.fullName, holderVerified: true,
      oneWonVerified: true, live: false, vendor: bankVendor.name }, jurisdiction: 410, assurance: 3,
    identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
  }, new KrAdapter(idVendor, bankVendor, { sandboxBits: true }),
  new MockAmlEngine({ evidenceKey: 'synthetic-only-at-least-32-chars-long-evidence' }), 1700000000000);
  assert.equal(out.status, 'ISSUED'); if (out.status !== 'ISSUED') return;
  assert.equal(out.regime, 2, 'cannot satisfy production policy requiredRegime=1');
  const evidence = (out.evidence as EvidenceStep[]).find(s => s.step === 'jurisdiction_adapter')!.payload;
  assert.equal((evidence.idDocument as { live: boolean }).live, false);
  assert.equal((evidence.bankAccount as { live: boolean }).live, false);
});

test('PM-T35-02 matching sample uses the activated official three-source artifact and still cannot become production', async () => {
  const { entries, meta } = readIndex(readFileSync('web/data/sanctions-index.json.gz'));
  assert.ok(meta.counts.OFAC_SDN > 10_000 && meta.counts.UN_CONSOLIDATED > 500 && meta.counts.EU_FSF > 5_000,
    `activated corpus is not the complete three-source fixture: ${JSON.stringify(meta.counts)}`);
  const profile = syntheticProfile('success');
  const idVendor = new DemoIdDocumentVendor(0), bankVendor = new DemoBankAccountVendor(0);
  const id = await idVendor.verify({ ...profile.doc, docType: profile.docType, image: new Uint8Array([1, 2, 3]) });
  assert.equal(id.kind, 'verified');
  if (id.kind !== 'verified') return;
  const out = await runIssuance({ wallet: '0x' + 'cd'.repeat(20), walletControlProven: true, jurisdiction: 410, assurance: 3,
    identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
    declared: { fullName: profile.doc.fullName, dateOfBirth: '2000-01-01', ...profile.country }, idDocument: id,
    bankAccount: { bankCode: profile.bank.bankCode, holderName: profile.doc.fullName, holderVerified: true,
      oneWonVerified: true, live: false, vendor: bankVendor.name },
  }, new KrAdapter(idVendor, bankVendor, { sandboxBits: true }), new ListBackedAmlEngine({ entries,
    listVersions: meta.listVersions, provenance: meta.provenance, maxAgeHours: 168,
    evidenceKey: 'synthetic-official-artifact-test-key-at-least-32-chars', keyId: 't35-local-test' }));
  assert.equal(out.status, 'ISSUED');
  if (out.status !== 'ISSUED') return;
  assert.equal(out.screeningSnapshotId, meta.provenance.snapshotId);
  assert.equal(out.regime, 2, 'official screening cannot promote demo document/bank results to production regime 1');
});
