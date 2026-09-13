import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { DemoIdDocumentVendor, DemoBankAccountVendor } from './adapters/demo.js';
import { KrAdapter, Regime } from './adapters/kr.js';
import { Methods } from './methods.js';
import { MockAmlEngine } from './aml.js';
import { runIssuance } from './issue.js';
import { findPii } from './pii-guard.js';
import { SYNTHETIC_INDIVIDUAL_NONFACE_POLICY } from './identity-policy.js';

/**
 * The demo vendors and the sandboxBits switch. What matters: a demo result is never live, the
 * switch is the only way it becomes a bit, and when it does the mark says sandbox and the evidence
 * says demo. Both outcomes (genuine / forged, holder match / mismatch) are reachable on purpose.
 */
const IMAGE = new Uint8Array([9, 8, 7]);
const idVendor = new DemoIdDocumentVendor(0);
const bankVendor = new DemoBankAccountVendor(0);

describe('demo vendors', () => {
  test('the ID vendor answers like the authority would, without asking it', async () => {
    const out = await idVendor.verify({ docType: 'RRC', image: IMAGE, fullName: '\uD64D\uAE38\uB3D9', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' });
    assert.equal(out.kind, 'verified');
    if (out.kind !== 'verified') return;
    assert.equal(out.live, false);
    assert.equal(out.vendor, 'demo:id');
    assert.equal(out.authentic, true);
    assert.equal(out.authenticityChecked, true);
    assert.match(out.ref ?? '', /^demo-/);
    assert.equal(out.dateOfBirth, '1990-01-01');
  });

  test('a forged demo document is rejected: the Korean word for "forged" in the name or a repeated-digit number', async () => {
    const a = await idVendor.verify({ docType: 'RRC', image: IMAGE, fullName: '\uC704\uC870 \uD64D\uAE38\uB3D9', birthDate: '19900101', rrn: '9001011234567', issueDate: '20200101' });
    assert.equal(a.kind === 'verified' && a.authentic, false);
    const b = await idVendor.verify({ docType: 'DL', image: IMAGE, fullName: '\uD64D\uAE38\uB3D9', birthDate: '19900101', licenseNumber: '111111111111', serialNo: 'AB12CD' });
    assert.equal(b.kind === 'verified' && b.authentic, false);
  });

  test('the demo OCR reads nothing, so the customer types', async () => {
    assert.deepEqual(await idVendor.ocr(IMAGE, 'DL'), { docType: 'DL' });
  });

  test('the demo bank echoes the declared holder, except for an account ending in 99', async () => {
    const h = await bankVendor.holderName({ bankCode: '004', accountNumber: '110123456789', birthDate: '900101', declaredName: '\uD64D\uAE38\uB3D9' });
    assert.equal(h.holderName, '\uD64D\uAE38\uB3D9');
    const other = await bankVendor.holderName({ bankCode: '004', accountNumber: '110123456799', birthDate: '900101', declaredName: '\uD64D\uAE38\uB3D9' });
    assert.equal(other.holderName, 'Different Person');
    await assert.rejects(bankVendor.holderName({ bankCode: '004', accountNumber: '1', birthDate: '900101' }), /declared name/);
  });

  test('the one-won code is stable per account and four digits', async () => {
    const a = await bankVendor.oneWonTransfer({ bankCode: '004', accountNumber: '110123456789', holderName: '\uD64D\uAE38\uB3D9' });
    const b = await bankVendor.oneWonTransfer({ bankCode: '004', accountNumber: '110123456789', holderName: '\uD64D\uAE38\uB3D9' });
    assert.equal(a.authCode, b.authCode);
    assert.match(a.authCode, /^\d{4}$/);
    assert.equal(a.authCode, DemoBankAccountVendor.codeFor('004', '110123456789'));
    const c = await bankVendor.oneWonTransfer({ bankCode: '088', accountNumber: '110123456789', holderName: '\uD64D\uAE38\uB3D9' });
    assert.notEqual(a.authCode, c.authCode);
  });
});

describe('sandboxBits', () => {
  const idOk = { docType: 'RRC' as const, fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01', docHash: '0xdoc',
    authenticityChecked: true, authentic: true, faceMatched: false, livenessPassed: false, vendor: 'demo:id', live: false };
  const bankOk = { bankCode: '004', holderName: '\uD64D\uAE38\uB3D9', holderVerified: true, oneWonVerified: true, vendor: 'demo:bank', live: false };

  test('off by default: demo results set nothing and the regime is sandbox', async () => {
    const a = new KrAdapter(idVendor, bankVendor);
    assert.equal(a.connected, true);
    assert.equal(a.live, false);
    assert.equal(a.regime, Regime.KR_FSC_NONFACE_SANDBOX);
    const r = await a.run({ walletControlProven: true, idDocument: idOk, bankAccount: bankOk });
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0);
    assert.equal(r.methods & Methods.BANK_ACCOUNT, 0);
    assert.equal(r.evidence.sandboxBits, false);
  });

  test('on: the bits are set, the regime stays sandbox, the evidence says so', async () => {
    const a = new KrAdapter(idVendor, bankVendor, { sandboxBits: true });
    assert.equal(a.regime, Regime.KR_FSC_NONFACE_SANDBOX, 'a demo vendor can never make the regime production');
    const r = await a.run({ walletControlProven: true, idDocument: idOk, bankAccount: bankOk });
    assert.ok(r.methods & Methods.ID_DOC_AUTHENTICITY);
    assert.ok(r.methods & Methods.BANK_ACCOUNT);
    assert.equal(r.evidence.sandboxBits, true);
    assert.equal((r.evidence.idDocument as { live: boolean; vendor: string }).live, false);
    assert.equal((r.evidence.idDocument as { vendor: string }).vendor, 'demo:id');
  });

  test('on: a forged demo document still stops issuance', async () => {
    const a = new KrAdapter(idVendor, bankVendor, { sandboxBits: true });
    const r = await a.run({ walletControlProven: true, idDocument: { ...idOk, authentic: false }, bankAccount: bankOk });
    assert.match(r.rejected ?? '', /did not confirm/);
  });

  test('end to end through the pipeline: issued with the bits, regime 2, no PII in the evidence', async () => {
    const a = new KrAdapter(idVendor, bankVendor, { sandboxBits: true });
    const out = await runIssuance({
      wallet: '0x' + 'ab'.repeat(20),
      declared: { fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR' },
      idDocument: idOk, bankAccount: bankOk, walletControlProven: true, jurisdiction: 410, assurance: 3,
      identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
    }, a, new MockAmlEngine({ evidenceKey: 'test-only-evidence-key-at-least-32-chars-long' }), 1_700_000_000_000);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;
    assert.equal(out.regime, Regime.KR_FSC_NONFACE_SANDBOX);
    assert.ok(out.methodNames.includes('ID_DOC_AUTHENTICITY'));
    assert.ok(out.methodNames.includes('BANK_ACCOUNT'));
    assert.equal(findPii(out.evidence, ['\uD64D\uAE38\uB3D9', '1990-01-01']), null);
  });
});
