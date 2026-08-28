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

/** 테스트 전용 증적 키. 운영에서는 EVIDENCE_HMAC_KEY 를 env 로 주입한다. */
const TEST_EVIDENCE_KEY = 'test-only-evidence-key-at-least-32-chars-long';

// ═══════════ 1. Solidity 와의 일치 ═══════════

describe('Solidity 정합성', () => {
  test('packAttrs 가 Solidity MarkAttrs.pack 과 바이트 단위로 같다', () => {
    // test/AttrsVector.t.sol:test_KnownVectorMatchesTypeScript 의 기대값
    assert.equal(
      packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410,
                  methods: 0x10024, issuedAt: 1_700_000_000, expiry: 1_800_000_000, epoch: 0 }),
      '0x01030002019a00010024006553f100006b49d200000000000000000000000000',
    );
  });

  test('pack/unpack 왕복', () => {
    const input = { kind: 2, assurance: 5, regime: 1, jurisdiction: 840,
                    methods: 0x19003f, issuedAt: 1_755_000_000, expiry: 1_790_000_000, epoch: 7 };
    assert.deepEqual(unpackAttrs(packAttrs(input)), input);
  });

  test('범위를 벗어난 값은 거부한다', () => {
    assert.throws(() => packAttrs({ kind: 256, assurance: 1, regime: 1, jurisdiction: 410,
                                    methods: 0, issuedAt: 0, expiry: 0, epoch: 0 }), /범위/);
  });

  test('리포지토리 전역 — 어디에 중복 정의가 있든 Solidity 와 일치한다', () => {
    // pipeline/methods.ts 외에 aml/types.ts 등에도 비트 상수가 중복 정의될 수 있다.
    // 정의가 갈리면 마크의 의미가 조용히 달라지므로, 소스를 훑어 전부 대조한다.
    // (근본 해법은 pipeline/methods.ts 를 단일 정본으로 import 하는 것이다)
    const sol = readFileSync('src/lib/ProofmarkTypes.sol', 'utf8');
    const solBits = new Map<string, number>();
    for (const m of sol.matchAll(/uint32 internal constant (\w+)\s*=\s*1 << (\d+);/g)) {
      solBits.set(m[1], 1 << Number(m[2]));
    }
    assert.ok(solBits.size >= 15, 'Solidity 비트 상수를 읽지 못했습니다');

    const files = ['pipeline/methods.ts', 'aml/types.ts'];
    let checked = 0;
    for (const f of files) {
      let src: string;
      try { src = readFileSync(f, 'utf8'); } catch { continue; }   // 아직 없는 파일은 건너뛴다
      for (const m of src.matchAll(/(\w+):\s*1 << (\d+)/g)) {
        const [, name, shift] = m;
        if (!solBits.has(name)) continue;
        assert.equal(1 << Number(shift), solBits.get(name),
          `${f} 의 ${name} 비트 위치가 ProofmarkTypes.sol 과 다릅니다`);
        checked++;
      }
    }
    assert.ok(checked > 0, '대조된 상수가 없습니다');
  });

  test('Methods 비트맵이 ProofmarkTypes.sol 과 일치한다', () => {
    // 두 정의가 갈리면 마크의 의미가 조용히 달라진다 — 소스에서 직접 읽어 대조한다
    const sol = readFileSync('src/lib/ProofmarkTypes.sol', 'utf8');
    for (const [name, value] of Object.entries(Methods)) {
      const m = new RegExp(`uint32 internal constant ${name}\\s*=\\s*1 << (\\d+);`).exec(sol);
      assert.ok(m, `Solidity 에 ${name} 이 없습니다`);
      assert.equal(value, 1 << Number(m![1]), `${name} 비트 위치 불일치`);
    }
  });
});

// ═══════════ 2. 증적 체인 ═══════════

describe('EvidenceChain', () => {
  const steps = [
    { step: 'a', at: 1000, payload: { z: 1, a: 2 } },
    { step: 'b', at: 2000, payload: { nested: { y: 1, x: 2 } } },
  ];

  test('감사인이 사본으로 재계산할 수 있다', () => {
    const c = new EvidenceChain();
    for (const s of steps) c.append(s);
    assert.equal(EvidenceChain.recompute(c.export()), c.hash);
  });

  test('키 순서가 달라도 같은 해시 — 결정적 직렬화', () => {
    const a = new EvidenceChain();
    a.append({ step: 'x', at: 1, payload: { alpha: 1, beta: 2 } });
    const b = new EvidenceChain();
    b.append({ step: 'x', at: 1, payload: { beta: 2, alpha: 1 } });
    assert.equal(a.hash, b.hash);
  });

  test('한 단계라도 바뀌면 head 가 달라진다 — 위변조 탐지', () => {
    const c = new EvidenceChain();
    for (const s of steps) c.append(s);
    const tampered = c.export();
    (tampered[0].payload as any).z = 999;
    assert.notEqual(EvidenceChain.recompute(tampered), c.hash);
  });

  test('비결정적 값은 거부한다', () => {
    assert.throws(() => canonicalJson({ n: NaN }), /유한하지 않은/);
    assert.throws(() => canonicalJson({ d: new Date(0) }), /Date/);
  });
});

// ═══════════ 3. 클레임 커밋먼트 ═══════════

describe('클레임 커밋먼트', () => {
  const claims: Claim[] = [
    { key: 'fullName',    value: '홍길동',      salt: '0x' + '11'.repeat(32) },
    { key: 'dateOfBirth', value: '1990-01-01', salt: '0x' + '22'.repeat(32) },
    { key: 'nationality', value: 'KR',         salt: '0x' + '33'.repeat(32) },
  ];

  test('선택공개가 검증된다', () => {
    const root = claimsRoot(claims);
    const { claim, proof } = discloseClaim(claims, 'dateOfBirth');
    assert.ok(verifyDisclosure(root, claim, proof));
  });

  test('값을 위조하면 검증이 실패한다', () => {
    const root = claimsRoot(claims);
    const { claim, proof } = discloseClaim(claims, 'dateOfBirth');
    assert.ok(!verifyDisclosure(root, { ...claim, value: '1980-01-01' }, proof));
  });

  test('salt 가 다르면 리프가 다르다 — 원문 역산 방지', () => {
    const a = claimLeaf({ key: 'k', value: 'v', salt: '0x' + 'aa'.repeat(32) });
    const b = claimLeaf({ key: 'k', value: 'v', salt: '0x' + 'bb'.repeat(32) });
    assert.notEqual(a, b);
  });

  test('salt 는 매번 다르다', () => {
    assert.notEqual(newSalt(), newSalt());
  });
});

// ═══════════ 4. 맵핑 대사 ═══════════

describe('맵핑 대사 (3축)', () => {
  const base = {
    declared: { fullName: '홍길동', dateOfBirth: '1990-01-01' },
    idDocument: { fullName: '홍길동', dateOfBirth: '1990-01-01' },
    bankAccount: { holderName: '홍 길동' },   // 공백 차이는 정규화로 흡수
  };

  test('세 축이 모두 일치하면 통과', () => {
    const r = reconcile(base);
    assert.ok(r.passed);
    assert.equal(r.axes.declaredVsIdDoc, 'match');
    assert.equal(r.axes.idDocVsBank, 'match');
  });

  test('예금주가 다르면 탈락', () => {
    const r = reconcile({ ...base, bankAccount: { holderName: '김철수' } });
    assert.ok(!r.passed);
    assert.equal(r.axes.declaredVsBank, 'mismatch');
  });

  test('생년월일이 다르면 탈락', () => {
    const r = reconcile({ ...base, idDocument: { fullName: '홍길동', dateOfBirth: '1991-01-01' } });
    assert.ok(!r.passed);
  });

  test('원문을 반환하지 않는다 — 해시만', () => {
    const r = reconcile(base);
    // 정규화 형태를 가로질러 검사한다 — 단순 includes 는 NFD 한글을 놓친다
    assert.ok(!containsPii(r, '홍길동'), '대사 결과에 PII 원문이 들어 있으면 안 된다');
  });

  test('정규화', () => {
    assert.equal(normalizeName(' hong  gil-dong '), 'HONGGILDONG');
  });
});

// ═══════════ 5. ★ 정직성 보장 — 미연동 벤더는 비트를 세우지 않는다 ═══════════

describe('KR 어댑터 — 정직성', () => {
  const idVendor: IdDocumentVendor = {
    async verify() {
      return { fullName: '홍길동', dateOfBirth: '1990-01-01', docHash: '0xdoc',
               authenticityChecked: true, faceMatched: true, livenessPassed: true };
    },
  };
  const bankVendor: BankAccountVendor = {
    async verifyHolder() { return { holderName: '홍길동', verified: true }; },
  };

  test('벤더 미연동이면 해당 비트를 세우지 않는다', async () => {
    const sandbox = new KrAdapter(null, null);
    assert.ok(!sandbox.connected);
    assert.equal(sandbox.regime, Regime.KR_FSC_NONFACE_SANDBOX);

    const r = await sandbox.run({ idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' },
                                  walletControlProven: true });
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, '미연동인데 진위확인 비트가 섰다');
    assert.equal(r.methods & Methods.BANK_ACCOUNT, 0, '미연동인데 계좌 비트가 섰다');
    assert.equal(r.methods & Methods.WALLET_CONTROL, Methods.WALLET_CONTROL, '지갑 소유권은 우리가 직접 하므로 서야 한다');
  });

  test('벤더 연동 시에만 비트가 선다', async () => {
    const live = new KrAdapter(idVendor, bankVendor);
    assert.equal(live.regime, Regime.KR_FSC_NONFACE);
    const r = await live.run({ idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' },
                               walletControlProven: true });
    assert.ok(r.methods & Methods.ID_DOC_AUTHENTICITY);
    assert.ok(r.methods & Methods.BANK_ACCOUNT);
    assert.ok(r.methods & Methods.LIVENESS);
  });

  test('벤더가 진위확인을 안 했다고 보고하면 비트를 세우지 않는다', async () => {
    const partial: IdDocumentVendor = {
      async verify() {
        return { fullName: '홍길동', dateOfBirth: '1990-01-01', docHash: '0xdoc',
                 authenticityChecked: false, faceMatched: true, livenessPassed: false };
      },
    };
    const r = await new KrAdapter(partial, bankVendor).run({
      idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' }, walletControlProven: true });
    assert.ok(r.methods & Methods.ID_DOC_IMAGE, '사본 제출은 했다');
    assert.equal(r.methods & Methods.ID_DOC_AUTHENTICITY, 0, '조회 안 했으면 비트 0');
    assert.equal(r.methods & Methods.LIVENESS, 0);
  });
});

describe('Mock AML — 정직성', () => {
  test('실제 명단을 안 보므로 SANCTIONS_SCREENED 비트를 세우지 않는다', async () => {
    const r = await new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }).screen({
      fullName: '홍길동', dateOfBirth: '1990-01-01', nationality: 'KR', residence: 'KR',
      walletAddress: '0x' + '11'.repeat(20),
    });
    assert.equal(r.methodsApplied & Methods.SANCTIONS_SCREENED, 0);
    assert.ok(r.methodsApplied & Methods.JURISDICTION_CHECK, '관할 확인은 실제로 했다');
    assert.equal(r.decision, 'ALLOW');
  });

  test('고위험 관할은 BLOCK', async () => {
    const r = await new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }).screen({
      fullName: 'X', dateOfBirth: '1990-01-01', nationality: 'KP', residence: 'KP',
      walletAddress: '0x' + '11'.repeat(20),
    });
    assert.equal(r.decision, 'BLOCK');
    assert.equal(r.riskBand, 5);
  });
});

// ═══════════ 6. 발급 오케스트레이션 ═══════════

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

  test('지갑 소유권 미증명이면 거절', async () => {
    const out = await runIssuance({ ...req, walletControlProven: false },
                                  new KrAdapter(null, null), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'REJECTED');
  });

  test('고위험 관할은 DENIED', async () => {
    const out = await runIssuance(
      { ...req, declared: { ...req.declared, residence: 'KP' } },
      new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'DENIED');
  });

  test('정상 발급 — methods 가 실제 수행한 것만 담는다', async () => {
    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    const names = new Set(out.methodNames);
    assert.ok(names.has('ID_DOC_AUTHENTICITY'));
    assert.ok(names.has('BANK_ACCOUNT'));
    assert.ok(names.has('JURISDICTION_CHECK'));
    // ★ 모의 AML 이므로 제재 스크리닝 비트는 없다
    assert.ok(!names.has('SANCTIONS_SCREENED'), '모의 AML 인데 제재 비트가 섰다');

    // riskBand 2 → 180일
    const un = unpackAttrs(out.attrs);
    assert.equal(un.expiry - un.issuedAt, EXPIRY_DAYS_BY_BAND[2] * 86_400);
    assert.equal(un.jurisdiction, 410);
    assert.equal(un.regime, Regime.KR_FSC_NONFACE);
  });

  test('★ 모의 구성으로 발급한 마크는 KR 정책을 통과하지 못한다', async () => {
    // 배포된 KR 정책(policyId 1) = ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED
    const KR_POLICY = Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;

    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    assert.notEqual(out.methods & KR_POLICY, KR_POLICY,
      '모의 AML 로 발급했는데 KR 정책을 통과한다면 거짓말이 온체인에 올라간 것이다');
  });

  test('증적 체인이 사본으로 재계산된다', async () => {
    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;
    assert.equal(EvidenceChain.recompute(out.evidence as any), out.evidenceHash);
  });

  test('증적에 PII 원문이 없다', async () => {
    const out = await runIssuance(req, new KrAdapter(liveId, liveBank), new MockAmlEngine({ evidenceKey: TEST_EVIDENCE_KEY }), NOW);
    if (out.status !== 'ISSUED') return;
    const leaked = findPii(out.evidence, ['홍길동', '110-123', '1990-01-01']);
    assert.equal(leaked, null, `증적에 PII 가 들어 있다: ${leaked}`);
  });
});

// ═══════════ 7. 증적 가명화 키 ═══════════

describe('증적 가명화 키', () => {
  test('키가 없으면 기동하지 않는다 — 기본값을 두지 않는다', () => {
    assert.throws(() => loadEvidenceKey({}), /EVIDENCE_HMAC_KEY/);
    assert.throws(() => loadEvidenceKey({ EVIDENCE_HMAC_KEY: 'short' }), /32자/);
  });

  test('키가 있으면 keyId 와 함께 반환한다', () => {
    const k = loadEvidenceKey({ EVIDENCE_HMAC_KEY: 'x'.repeat(40), EVIDENCE_KEY_ID: 'k7' });
    assert.equal(k.keyId, 'k7');
  });

  test('모의 엔진도 키 없이는 생성되지 않는다', () => {
    // 모의 엔진만 무염 해시를 쓰면 "보호된 것처럼 보이지만 아닌" 상태가 생긴다
    assert.throws(() => new MockAmlEngine({} as any), /evidenceKey/);
  });

  test('키가 다르면 다이제스트가 다르다 — 사전공격 방어', () => {
    const a = hmacDigest('key-a'.repeat(10), '박서준');
    const b = hmacDigest('key-b'.repeat(10), '박서준');
    assert.notEqual(a, b);
  });

  test('정규화 형태가 달라도 같은 다이제스트 — NFC/NFD 가 갈리지 않는다', () => {
    const k = 'k'.repeat(40);
    assert.equal(hmacDigest(k, '박서준'.normalize('NFC')), hmacDigest(k, '박서준'.normalize('NFD')));
  });
});
