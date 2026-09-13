import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KrAdapter, Regime, type IdDocumentResult, type BankAccountResult, type IdDocumentVendor, type BankAccountVendor } from './adapters/kr.js';
import { Methods } from './methods.js';
import { MockAmlEngine } from './aml.js';
import { runIssuance } from './issue.js';
import { unpackAttrs } from './attrs.js';
import { policyWarnings } from './policy.js';
import { SYNTHETIC_INDIVIDUAL_NONFACE_POLICY } from './identity-policy.js';

const id: IdDocumentResult = { docType: 'RRC', fullName: 'Synthetic Person', dateOfBirth: '1990-01-01', docHash: '0x' + '12'.repeat(32),
  authenticityChecked: true, authentic: true, faceMatched: false, livenessPassed: false, vendor: 'synthetic:id', live: true };
const bank: BankAccountResult = { bankCode: '004', holderName: 'Synthetic Person', holderVerified: true, oneWonVerified: true, vendor: 'synthetic:bank', live: true };
const idVendor: IdDocumentVendor = { name: id.vendor, live: true, biometricChecks: [], verify: async () => { throw new Error('no external call authorized'); } };
const bankVendor: BankAccountVendor = { name: bank.vendor, live: true, holderName: async () => { throw new Error('no external call authorized'); }, oneWonTransfer: async () => { throw new Error('no transfer authorized'); } };

test('production configuration cannot promote old sandbox, mixed, absent or incomplete results', async () => {
  const adapter = new KrAdapter(idVendor, bankVendor);
  assert.equal(adapter.regime, Regime.KR_FSC_NONFACE, 'configuration advertises capability only');
  for (const [idDocument, bankAccount] of [
    [{ ...id, live: false }, { ...bank, live: false }], [{ ...id, live: false }, bank], [id, { ...bank, live: false }],
    [null, null], [id, null], [null, bank], [{ ...id, authenticityChecked: false }, bank], [id, { ...bank, oneWonVerified: false }],
  ] as [IdDocumentResult | null, BankAccountResult | null][]) {
    const result = await adapter.run({ walletControlProven: true, idDocument, bankAccount });
    assert.equal(result.regime, Regime.KR_FSC_NONFACE_SANDBOX);
    assert.equal(result.evidence.configuredRegime, Regime.KR_FSC_NONFACE);
    assert.equal(result.evidence.liveResultsComplete, false);
  }
});

test('both real completed results earn regime 1; sandbox switch and disconnected capability cannot', async () => {
  const input = { walletControlProven: true, idDocument: id, bankAccount: bank };
  assert.equal((await new KrAdapter(idVendor, bankVendor).run(input)).regime, Regime.KR_FSC_NONFACE);
  assert.equal((await new KrAdapter(idVendor, bankVendor, { sandboxBits: true }).run(input)).regime, Regime.KR_FSC_NONFACE_SANDBOX);
  assert.equal((await new KrAdapter(null, null).run(input)).regime, Regime.KR_FSC_NONFACE_SANDBOX);
});

test('demo-derived method bits remain sandbox through the packed issuance output after a configuration switch', async () => {
  const result = await runIssuance({ wallet: '0x' + '34'.repeat(20), declared: { fullName: id.fullName, dateOfBirth: id.dateOfBirth, nationality: 'KR', residence: 'KR' },
    idDocument: { ...id, live: false }, bankAccount: { ...bank, live: false }, walletControlProven: true, jurisdiction: 410, assurance: 3,
    identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
  }, new KrAdapter(idVendor, bankVendor, { sandboxBits: true }), new MockAmlEngine({ evidenceKey: 'synthetic-provenance-key' }));
  assert.equal(result.status, 'ISSUED'); if (result.status !== 'ISSUED') return;
  assert.equal(result.regime, Regime.KR_FSC_NONFACE_SANDBOX); assert.equal(unpackAttrs(result.attrs).regime, Regime.KR_FSC_NONFACE_SANDBOX);
  assert.ok(result.methods & Methods.ID_DOC_AUTHENTICITY); assert.ok(result.methods & Methods.BANK_ACCOUNT);
});

test('SDK warns about unsupported exposure without rewriting the consumer requirement', () => {
  const policy = { requireAll: Methods.ONCHAIN_EXPOSURE, minAssurance: 1, maxAge: 60, requiredRegime: 1,
    requiredJurisdiction: 410, trustedIssuer: '0x' + '12'.repeat(20), requireRoster: false };
  assert.ok(policyWarnings(policy, 1).some(w => w.includes('cannot satisfy ONCHAIN_EXPOSURE')));
  assert.equal(policy.requireAll, Methods.ONCHAIN_EXPOSURE);
});
