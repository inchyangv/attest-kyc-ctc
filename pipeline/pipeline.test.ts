import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { canonicalJson } from './canonical.js';
import { EvidenceChain } from './evidence.js';
import { claimsRoot, claimLeaf, discloseClaim, verifyDisclosure, newSalt, type Claim } from './claims.js';
import { reconcile, normalizeName } from './reconcile.js';
import { packAttrs, unpackAttrs } from './attrs.js';
import { Methods, describeMethods } from './methods.js';
import { MockAmlEngine, EXPIRY_DAYS_BY_BAND } from './aml.js';
import { KrAdapter, Regime, type IdDocumentVendor, type BankAccountVendor } from './adapters/kr.js';
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
    { key: 'fullName',    value: '홍길동',      salt: '0x' + '11'.repeat(32) },
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
    declared: { fullName: '홍길동', dateOfBirth: '1990-01-01' },
    idDocument: { fullName: '홍길동', dateOfBirth: '1990-01-01' },
    bankAccount: { holderName: '홍 길동' },   // 공백 차이는 정규화로 흡수
  };

  test('all three axes agree, so it passes', () => {
    const r = reconcile(base);
    assert.ok(r.passed);
    assert.equal(r.axes.declaredVsIdDoc, 'match');
    assert.equal(r.axes.idDocVsBank, 'match');
  });

  test('a different account holder fails', () => {
    const r = reconcile({ ...base, bankAccount: { holderName: '김철수' } });
    assert.ok(!r.passed);
    assert.equal(r.axes.declaredVsBank, 'mismatch');
  });

  test('a different date of birth fails', () => {
    const r = reconcile({ ...base, idDocument: { fullName: '홍길동', dateOfBirth: '1991-01-01' } });
    assert.ok(!r.passed);
  });

  test('no cleartext is returned, only hashes', () => {
    const r = reconcile(base);
    // Check across normal forms. A plain includes misses NFD Hangul.
    assert.ok(!containsPii(r, '홍길동'), 'the reconciliation result must not carry cleartext PII');
  });

  test('normalisation', () => {
    assert.equal(normalizeName(' hong  gil-dong '), 'HONGGILDONG');
  });
});

// 5. Honesty: an unconnected vendor leaves its bit unset

describe('KR adapter honesty', () => {
  const idVendor: IdDocumentVendor = {
    async verify() {
      return { fullName: '홍길동', dateOfBirth: '1990-01-01', docHash: '0xdoc',
               authenticityChecked: true, faceMatched: true, livenessPassed: true };
    },
  };
  const bankVendor: BankAccountVendor = {
    async verifyHolder() { return { holderName: '홍길동', verified: true }; },
  };

  test('an unconnected vendor leaves its bit unset', async () => {
    const sandbox = new KrAdapter(null, null);
    assert.ok(!sandbox.connected);
    assert.equal(sandbox.regime, Regime.KR_FSC_NONFACE_SANDBOX);

    const r = await sandbox.run({ idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' },
                                  walletControlProven: true });
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, 'the document authenticity bit is set with no vendor connected');
    assert.equal(r.methods & Methods.BANK_ACCOUNT, 0, 'the bank account bit is set with no vendor connected');
    assert.equal(r.methods & Methods.WALLET_CONTROL, Methods.WALLET_CONTROL, 'we perform wallet control ourselves, so this bit must be set');
  });

  test('the bits appear only once a vendor is connected', async () => {
    const live = new KrAdapter(idVendor, bankVendor);
    assert.equal(live.regime, Regime.KR_FSC_NONFACE);
    const r = await live.run({ idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' },
                               walletControlProven: true });
    assert.ok(r.methods & Methods.ID_DOC_AUTHENTICITY);
    assert.ok(r.methods & Methods.BANK_ACCOUNT);
    assert.ok(r.methods & Methods.LIVENESS);
  });

  test('a vendor reporting no authenticity check leaves that bit unset', async () => {
    const partial: IdDocumentVendor = {
      async verify() {
        return { fullName: '홍길동', dateOfBirth: '1990-01-01', docHash: '0xdoc',
                 authenticityChecked: false, faceMatched: true, livenessPassed: false };
      },
    };
    const r = await new KrAdapter(partial, bankVendor).run({
      idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' }, walletControlProven: true });
    assert.ok(r.methods & Methods.ID_DOC_IMAGE, 'the document image was submitted');
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, 'no lookup means the bit stays at zero');
    assert.equal(r.methods & Methods.LIVENESS, 0);
  });
});

describe('mock AML honesty', () => {
  test('it never reads a real list, so SANCTIONS_SCREENED stays unset', async () => {
    const r = await new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }).screen({
      fullName: '홍길동', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR',
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
    declared: { fullName: '홍길동', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR' },
    idImage: new Uint8Array([1]),
    bank: { bankCode: '004', accountNumber: '110-123' },
    walletControlProven: true,
    jurisdiction: 410,
    assurance: 3,
  };

  const liveId: IdDocumentVendor = {
    async verify() {
      return { fullName: '홍길동', dateOfBirth: '1990-01-01', docHash: '0xdoc',
               authenticityChecked: true, faceMatched: true, livenessPassed: true };
    },
  };
  const liveBank: BankAccountVendor = {
    async verifyHolder() { return { holderName: '홍길동', verified: true }; },
  };

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
    const leaked = findPii(out.evidence, ['홍길동', '110-123', '1990-01-01']);
    assert.equal(leaked, null, `PII found in the evidence: ${leaked}`);
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
    const a = hmacDigest('key-a'.repeat(10), '박서준');
    const b = hmacDigest('key-b'.repeat(10), '박서준');
    assert.notEqual(a, b);
  });

  test('normal form does not change the digest, so NFC and NFD agree', () => {
    const k = 'k'.repeat(40);
    assert.equal(hmacDigest(k, '박서준'.normalize('NFC')), hmacDigest(k, '박서준'.normalize('NFD')));
  });
});
