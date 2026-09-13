import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { canonicalJson } from './canonical.js';
import { EvidenceChain } from './evidence.js';
import { claimsRoot, claimLeaf, discloseClaim, verifyDisclosure, newSalt, type Claim } from './claims.js';
import { reconcile, normalizeName } from './reconcile.js';
import { packAttrs, unpackAttrs } from './attrs.js';
import { Methods, describeMethods } from './methods.js';
import { SYNTHETIC_INDIVIDUAL_NONFACE_POLICY } from './identity-policy.js';
import { MockAmlEngine, EXPIRY_DAYS_BY_BAND } from './aml.js';
import {
  KrAdapter, Regime, VendorError,
  type IdDocumentVendor, type BankAccountVendor, type IdDocumentResult, type BankAccountResult,
} from './adapters/kr.js';
import { runIssuance, type IssueRequest } from './issue.js';
import { containsPii, findPii } from './pii-guard.js';
import { loadEvidenceKey, hmacDigest } from './evidence-key.js';

/** Test-only evidence key. Production injects EVIDENCE_HMAC_KEY from the environment. */
const TEST_EVIDENCE_KEY = 'test-only-evidence-key-at-least-32-chars-long';

// 1. Agreement with Solidity

describe('Solidity agreement', () => {
  test('packAttrs matches Solidity MarkAttrs.pack byte for byte', () => {
    // expected value from test/AttrsVector.t.sol:test_KnownVectorMatchesTypeScript
    assert.equal(
      packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410,
                  methods: 0x10024, issuedAt: 1_700_000_000, expiry: 1_800_000_000, epoch: 0 }),
      '0x01030002019a00010024006553f100006b49d200000000000000000000000000',
    );
  });

  test('pack and unpack round trip', () => {
    const input = { kind: 2, assurance: 5, regime: 1, jurisdiction: 840,
                    methods: 0x19003f, issuedAt: 1_755_000_000, expiry: 1_790_000_000, epoch: 7 };
    assert.deepEqual(unpackAttrs(packAttrs(input)), input);
  });

  test('out-of-range values are rejected', () => {
    assert.throws(() => packAttrs({ kind: 256, assurance: 1, regime: 1, jurisdiction: 410,
                                    methods: 0, issuedAt: 0, expiry: 0, epoch: 0 }), /out of range/);
  });

  test('repository wide: every duplicate definition still matches Solidity', () => {
    // Bit constants can end up redefined outside pipeline/methods.ts, in aml/types.ts and elsewhere.
    // A drift changes what a mark means without any visible failure, so scan the sources and compare.
    // The real fix is importing pipeline/methods.ts everywhere instead of redefining.
    const sol = readFileSync('src/lib/ProofmarkTypes.sol', 'utf8');
    const solBits = new Map<string, number>();
    for (const m of sol.matchAll(/uint32 internal constant (\w+)\s*=\s*1 << (\d+);/g)) {
      solBits.set(m[1], 1 << Number(m[2]));
    }
    assert.ok(solBits.size >= 15, 'could not read the Solidity bit constants');

    const files = ['pipeline/methods.ts', 'aml/types.ts'];
    let checked = 0;
    for (const f of files) {
      let src: string;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }   // skip files that do not exist yet
      for (const m of src.matchAll(/(\w+):\s*1 << (\d+)/g)) {
        const [, name, shift] = m;
        if (!solBits.has(name)) continue;
        assert.equal(1 << Number(shift), solBits.get(name),
          `${name} in ${f} sits at a different bit than ProofmarkTypes.sol`);
        checked++;
      }
    }
    assert.ok(checked > 0, 'no constants were compared');
  });

  test('the Methods bitmap matches ProofmarkTypes.sol', () => {
    // A drift between the two changes what a mark means, so read the source and compare
    const sol = readFileSync('src/lib/ProofmarkTypes.sol', 'utf8');
    for (const [name, value] of Object.entries(Methods)) {
      const m = new RegExp(`uint32 internal constant ${name}\\s*=\\s*1 << (\\d+);`).exec(sol);
      assert.ok(m, `${name} is missing from Solidity`);
      assert.equal(value, 1 << Number(m![1]), `${name} sits at the wrong bit`);
    }
  });
});

// 2. Evidence chain

describe('EvidenceChain', () => {
  const steps = [
    { step: 'a', at: 1000, payload: { z: 1, a: 2 } },
    { step: 'b', at: 2000, payload: { nested: { y: 1, x: 2 } } },
  ];

  test('an auditor can recompute from a copy', () => {
    const c = new EvidenceChain();
    for (const s of steps) c.append(s);
    assert.equal(EvidenceChain.recompute(c.export()), c.hash);
  });

  test('key order does not change the hash; serialisation is deterministic', () => {
    const a = new EvidenceChain();
    a.append({ step: 'x', at: 1, payload: { alpha: 1, beta: 2 } });
    const b = new EvidenceChain();
    b.append({ step: 'x', at: 1, payload: { beta: 2, alpha: 1 } });
    assert.equal(a.hash, b.hash);
  });

  test('changing any step changes the head, which is how tampering shows', () => {
    const c = new EvidenceChain();
    for (const s of steps) c.append(s);
    const tampered = c.export();
    (tampered[0].payload as any).z = 999;
    assert.notEqual(EvidenceChain.recompute(tampered), c.hash);
  });

  test('non-deterministic values are rejected', () => {
    assert.throws(() => canonicalJson({ n: NaN }), /non-finite/);
    assert.throws(() => canonicalJson({ d: new Date(0) }), /Date/);
  });
});

// 3. Claim commitments

describe('claim commitments', () => {
  const claims: Claim[] = [
    { key: 'fullName',    value: '\uD64D\uAE38\uB3D9',      salt: '0x' + '11'.repeat(32) },
    { key: 'dateOfBirth', value: '1990-01-01', salt: '0x' + '22'.repeat(32) },
    { key: 'nationality', value: 'KR',         salt: '0x' + '33'.repeat(32) },
  ];

  test('selective disclosure verifies', () => {
    const root = claimsRoot(claims);
    const { claim, proof } = discloseClaim(claims, 'dateOfBirth');
    assert.ok(verifyDisclosure(root, claim, proof));
  });

  test('a forged value fails verification', () => {
    const root = claimsRoot(claims);
    const { claim, proof } = discloseClaim(claims, 'dateOfBirth');
    assert.ok(!verifyDisclosure(root, { ...claim, value: '1980-01-01' }, proof));
  });

  test('a different salt gives a different leaf, so the value cannot be reversed', () => {
    const a = claimLeaf({ key: 'k', value: 'v', salt: '0x' + 'aa'.repeat(32) });
    const b = claimLeaf({ key: 'k', value: 'v', salt: '0x' + 'bb'.repeat(32) });
    assert.notEqual(a, b);
  });

  test('salts differ every time', () => {
    assert.notEqual(newSalt(), newSalt());
  });
});

// 4. Reconciliation

describe('reconciliation across three axes', () => {
  const base = {
    declared: { fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01' },
    idDocument: { fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01' },
    bankAccount: { holderName: '\uD64D \uAE38\uB3D9' },   // Normalization absorbs spacing differences.
  };

  test('all three axes agree, so it passes', () => {
    const r = reconcile(base);
    assert.ok(r.passed);
    assert.equal(r.axes.declaredVsIdDoc, 'match');
    assert.equal(r.axes.idDocVsBank, 'match');
  });

  test('a different account holder fails', () => {
    const r = reconcile({ ...base, bankAccount: { holderName: '\uAE40\uCCA0\uC218' } });
    assert.ok(!r.passed);
    assert.equal(r.axes.declaredVsBank, 'mismatch');
  });

  test('a different date of birth fails', () => {
    const r = reconcile({ ...base, idDocument: { fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1991-01-01' } });
    assert.ok(!r.passed);
  });

  test('no cleartext is returned, only hashes', () => {
    const r = reconcile(base);
    // Check across normal forms. A plain includes misses NFD Hangul.
    assert.ok(!containsPii(r, '\uD64D\uAE38\uB3D9'), 'the reconciliation result must not carry cleartext PII');
  });

  test('normalisation', () => {
    assert.equal(normalizeName(' hong  gil-dong '), 'HONGGILDONG');
  });
});

// 5. Honesty: an unconnected vendor leaves its bit unset

const ID_OK: IdDocumentResult = {
  docType: 'RRC', fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01', docHash: '0xdoc',
  authenticityChecked: true, authentic: true, faceMatched: false, livenessPassed: false, vendor: 'fake', live: true,
};
const BANK_OK: BankAccountResult = {
  bankCode: '004', holderName: '\uD64D\uAE38\uB3D9', holderVerified: true, oneWonVerified: true, vendor: 'fake', live: true,
};
const fakeId: IdDocumentVendor = { name: 'fake', live: true, biometricChecks: [], async verify() { return { kind: 'verified', ...ID_OK }; } };
const fakeBank: BankAccountVendor = {
  name: 'fake',
  live: true,
  async holderName() { return { holderName: '\uD64D\uAE38\uB3D9', ref: 'tx-1' }; },
  async oneWonTransfer() { return { authCode: '4821', ref: 'tx-2' }; },
};

describe('KR adapter honesty', () => {
  test('an unconnected vendor leaves its bit unset', async () => {
    const sandbox = new KrAdapter(null, null);
    assert.ok(!sandbox.connected);
    assert.equal(sandbox.regime, Regime.KR_FSC_NONFACE_SANDBOX);

    const r = await sandbox.run({ idDocument: null, bankAccount: null, walletControlProven: true });
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, 'the document authenticity bit is set with no vendor connected');
    assert.equal(r.methods & Methods.BANK_ACCOUNT, 0, 'the bank account bit is set with no vendor connected');
    assert.equal(r.methods & Methods.WALLET_CONTROL, Methods.WALLET_CONTROL, 'we perform wallet control ourselves, so this bit must be set');
    assert.equal(r.rejected, null);
  });

  test('the bits appear only from a live vendor result', async () => {
    const live = new KrAdapter(fakeId, fakeBank);
    assert.equal(live.regime, Regime.KR_FSC_NONFACE);
    const r = await live.run({ idDocument: ID_OK, bankAccount: BANK_OK, walletControlProven: true });
    assert.ok(r.methods & Methods.ID_DOC_IMAGE);
    assert.ok(r.methods & Methods.ID_DOC_AUTHENTICITY);
    assert.ok(r.methods & Methods.BANK_ACCOUNT);
    assert.equal(r.methods & Methods.LIVENESS, 0, 'no liveness check ran');
  });

  test('a vendor that did not query the authority leaves that bit unset', async () => {
    const r = await new KrAdapter(fakeId, fakeBank).run({
      idDocument: { ...ID_OK, authenticityChecked: false, authentic: false }, bankAccount: BANK_OK, walletControlProven: true });
    assert.ok(r.methods & Methods.ID_DOC_IMAGE, 'the document image was submitted');
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, 'no lookup means the bit stays at zero');
    assert.equal(r.rejected, null, 'not checked is silence, not a failure');
  });

  test('a sandbox or testbed answer sets no bit even when it says yes', async () => {
    const r = await new KrAdapter(fakeId, fakeBank).run({
      idDocument: { ...ID_OK, live: false }, bankAccount: { ...BANK_OK, live: false }, walletControlProven: true });
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, 'a sandbox lookup is not the issuing authority');
    assert.equal(r.methods & Methods.BANK_ACCOUNT, 0, 'the testbed moves no money');
    assert.equal((r.evidence.idDocument as { live: boolean }).live, false, 'the evidence says which it was');
  });

  test('an authority that says no stops issuance', async () => {
    const r = await new KrAdapter(fakeId, fakeBank).run({
      idDocument: { ...ID_OK, authentic: false }, bankAccount: BANK_OK, walletControlProven: true });
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0);
    assert.match(r.rejected ?? '', /did not confirm/);
  });

  test('a one-won code that was never read back leaves the bank bit unset', async () => {
    const r = await new KrAdapter(fakeId, fakeBank).run({
      idDocument: ID_OK, bankAccount: { ...BANK_OK, oneWonVerified: false }, walletControlProven: true });
    assert.equal(r.methods & Methods.BANK_ACCOUNT, 0);
  });

  test('the holder lookup compares normalised names', async () => {
    const a = new KrAdapter(fakeId, fakeBank);
    const same = await a.lookupHolder({ bankCode: '004', accountNumber: '110-123-456789', birthDate: '900101', declaredName: ' \uD64D \uAE38\uB3D9' });
    assert.equal(same.matches, true);
    const other = await a.lookupHolder({ bankCode: '004', accountNumber: '110123456789', birthDate: '900101', declaredName: '\uAE40\uCCA0\uC218' });
    assert.equal(other.matches, false);
    await assert.rejects(a.lookupHolder({ bankCode: '999', accountNumber: '110123456789', birthDate: '900101', declaredName: '\uD64D\uAE38\uB3D9' }), VendorError);
    await assert.rejects(a.lookupHolder({ bankCode: '004', accountNumber: '110123456789', birthDate: '1990', declaredName: '\uD64D\uAE38\uB3D9' }), VendorError);
  });

  test('document input is validated before a vendor is called', async () => {
    const a = new KrAdapter(fakeId, fakeBank);
    const image = new Uint8Array([1, 2, 3]);
    await assert.rejects(a.verifyIdDocument({ docType: 'RRC', image, fullName: '\uD64D\uAE38\uB3D9', birthDate: '19900101', rrn: '123', issueDate: '20200101' }), /rrn/);
    await assert.rejects(a.verifyIdDocument({ docType: 'RRC', image, fullName: '\uD64D\uAE38\uB3D9', birthDate: '19900101', rrn: '8801011234567', issueDate: '20200101' }), /disagree/);
    await assert.rejects(a.verifyIdDocument({ docType: 'DL', image, fullName: '\uD64D\uAE38\uB3D9', birthDate: '19900101', licenseNumber: '12', serialNo: 'ABC123' }), /licenseNumber/);
    await assert.rejects(new KrAdapter(null, fakeBank).verifyIdDocument({ docType: 'DL', image, fullName: '\uD64D\uAE38\uB3D9', birthDate: '19900101', licenseNumber: '112233445566', serialNo: 'ABC123' }), /no ID document vendor/);
  });
});

describe('mock AML honesty', () => {
  test('it never reads a real list, so SANCTIONS_SCREENED stays unset', async () => {
    const r = await new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }).screen({
      fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR',
      walletAddress: '0x' + '11'.repeat(20),
    });
    assert.equal(r.methodsApplied & Methods.SANCTIONS_SCREENED, 0);
    assert.ok(r.methodsApplied & Methods.JURISDICTION_CHECK, 'the jurisdiction check did run');
    assert.equal(r.decision, 'ALLOW');
  });

  test('a high-risk jurisdiction blocks', async () => {
    const r = await new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }).screen({
      fullName: 'X', dateOfBirth: '1990-01-01', nationality: 'KP', residence: 'KP',
      walletAddress: '0x' + '11'.repeat(20),
    });
    assert.equal(r.decision, 'BLOCK');
    assert.equal(r.riskBand, 5);
  });
});

// 6. Issuance orchestration

describe('runIssuance', () => {
  const NOW = 1_700_000_000_000;
  const req: IssueRequest = {
    wallet: '0x' + 'ab'.repeat(20),
    declared: { fullName: '\uD64D\uAE38\uB3D9', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR' },
    idDocument: ID_OK,
    bankAccount: BANK_OK,
    walletControlProven: true,
    jurisdiction: 410,
    assurance: 3,
    identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
  };

  const liveId = fakeId;
  const liveBank = fakeBank;

  test('unproven wallet control is rejected', async () => {
    const out = await runIssuance({ ...req, walletControlProven: false },
                                  new KrAdapter(null, null), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'REJECTED');
  });

  test('a high-risk jurisdiction is denied', async () => {
    const out = await runIssuance(
      { ...req, declared: { ...req.declared, residence: 'KP' } },
      new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'DENIED');
  });

  test('a normal issuance records only the checks that ran', async () => {
    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    const names = new Set(out.methodNames);
    assert.ok(names.has('ID_DOC_AUTHENTICITY'));
    assert.ok(names.has('BANK_ACCOUNT'));
    assert.ok(names.has('JURISDICTION_CHECK'));
    // the AML engine is mocked, so there is no sanctions screening bit
    assert.ok(!names.has('SANCTIONS_SCREENED'), 'the sanctions bit is set under a mocked AML engine');

    // riskBand 2 means 180 days
    const un = unpackAttrs(out.attrs);
    assert.equal(un.expiry - un.issuedAt, EXPIRY_DAYS_BY_BAND[2] * 86_400);
    assert.equal(un.jurisdiction, 410);
    assert.equal(un.regime, Regime.KR_FSC_NONFACE);
  });

  test('a mark issued under the mock setup cannot pass the KR policy', async () => {
    // deployed KR policy (policyId 1) = ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED
    const KR_POLICY = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;

    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    assert.notEqual(out.methods & KR_POLICY, KR_POLICY,
      'passing the KR policy on a mocked issuance would put a lie on chain');
  });

  test('the evidence chain recomputes from a copy', async () => {
    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;
    assert.equal(EvidenceChain.recompute(out.evidence as any), out.evidenceHash);
  });

  test('the evidence carries no cleartext PII', async () => {
    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    if (out.status !== 'ISSUED') return;
    const leaked = findPii(out.evidence, ['\uD64D\uAE38\uB3D9', '110-123', '1990-01-01']);
    assert.equal(leaked, null, `PII found in the evidence: ${leaked}`);
  });

  test('a document the authority rejected is not issued', async () => {
    const out = await runIssuance({ ...req, idDocument: { ...ID_OK, authentic: false } },
                                  new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'REJECTED');
    if (out.status === 'REJECTED') assert.match(out.reason, /did not confirm/);
  });

  test('a holder name that disagrees with the document is not issued', async () => {
    const out = await runIssuance({ ...req, bankAccount: { ...BANK_OK, holderName: '\uAE40\uCCA0\uC218' } },
                                  new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'REJECTED');
    if (out.status === 'REJECTED') assert.match(out.reason, /reconciliation/);
  });
});

// 7. Evidence pseudonymisation key

describe('evidence pseudonymisation key', () => {
  test('no key means no start, because there is no default', () => {
    assert.throws(() => loadEvidenceKey({}), /EVIDENCE_HMAC_KEY/);
    assert.throws(() => loadEvidenceKey({ EVIDENCE_HMAC_KEY: 'short' }), /32 characters/);
  });

  test('a present key comes back with its keyId', () => {
    const k = loadEvidenceKey({ EVIDENCE_HMAC_KEY: 'x'.repeat(40), EVIDENCE_KEY_ID: 'k7' });
    assert.equal(k.keyId, 'k7');
  });

  test('the mock engine also refuses to construct without a key', () => {
    // If only the mock used an unsalted hash, we would have protection that looks real and is not
    assert.throws(() => new MockAmlEngine({} as any), /evidenceKey/);
  });

  test('a different key gives a different digest, which is the dictionary-attack defence', () => {
    const a = hmacDigest('key-a'.repeat(10), '\uBC15\uC11C\uC900');
    const b = hmacDigest('key-b'.repeat(10), '\uBC15\uC11C\uC900');
    assert.notEqual(a, b);
  });

  test('normal form does not change the digest, so NFC and NFD agree', () => {
    const k = 'k'.repeat(40);
    assert.equal(hmacDigest(k, '\uBC15\uC11C\uC900'.normalize('NFC')), hmacDigest(k, '\uBC15\uC11C\uC900'.normalize('NFD')));
  });
});
