import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { loadLists } from '../aml/loader.js';
import { ListBackedAmlEngine } from '../aml/engine.js';
import { KrAdapter, Regime, type IdDocumentVendor, type BankAccountVendor } from './adapters/kr.js';
import { runIssuance, type IssueRequest } from './issue.js';
import { unpackAttrs } from './attrs.js';
import { Methods } from './methods.js';
import type { AmlEngine } from './aml.js';
import { containsPii } from './pii-guard.js';

/**
 * 실물 AML 엔진 + 발급 파이프라인 통합.
 *
 * ★ 이 파일이 검증하는 것은 "정직성이 코드로 강제되는가" 이다.
 *   - 실제로 한 심사는 비트가 선다
 *   - 하지 않은 확인은 비트가 서지 않는다
 *   - 그 결과 우리 마크가 어떤 정책을 통과하고 어떤 정책에서 떨어지는가
 */

const HAVE_LISTS = existsSync('data/raw/ofac_sdn.xml');

/** 배포된 policyId 1 — KR VASP 실운영 */
const POLICY_KR_VASP =
  Methods.ID_DOC_AUTHENTICITY | Methods.BANK_ACCOUNT | Methods.SANCTIONS_SCREENED;

/** 제안된 policyId 2 — KR 파일럿. "우리가 실제로 하는 것"만으로 구성 */
const POLICY_PILOT =
  Methods.WALLET_CONTROL | Methods.JURISDICTION_CHECK |
  Methods.SANCTIONS_SCREENED | Methods.ONCHAIN_EXPOSURE;

describe('실물 AML + 파이프라인 통합', { skip: HAVE_LISTS ? false : 'data/raw 명단 원본 없음 (bash aml/fetch-lists.sh)' }, () => {
  let aml: AmlEngine;

  before(async () => {
    const { entries, listVersions } = await loadLists();
    aml = new ListBackedAmlEngine({ entries, listVersions, evidenceKey: 'test-only-evidence-key', keyId: 'test-k1' });
  });

  const NOW = 1_700_000_000_000;
  const cleanReq: IssueRequest = {
    wallet: '0x' + 'ab'.repeat(20),
    declared: { fullName: '박서준', dateOfBirth: '1988-03-14', nationality: 'KR', residence: 'KR' },
    idImage: null,
    walletControlProven: true,
    jurisdiction: 410,
    assurance: 3,
  };

  test('실물 명단이면 SANCTIONS_SCREENED 비트가 정당하게 선다', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    const names = new Set(out.methodNames);
    assert.ok(names.has('SANCTIONS_SCREENED'), '실물 명단을 조회했으므로 비트가 서야 한다');
    assert.ok(names.has('JURISDICTION_CHECK'));
    assert.ok(names.has('ONCHAIN_EXPOSURE'), 'OFAC 제재 지갑과 대조했으므로 서야 한다');
    assert.ok(names.has('WALLET_CONTROL'));
  });

  test('데이터 미연동 심사는 여전히 비트가 서지 않는다', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    const names = new Set(out.methodNames);
    assert.ok(!names.has('PEP_SCREENED'), 'PEP 데이터 미연동인데 비트가 섰다');
    assert.ok(!names.has('ADVERSE_MEDIA'), 'adverse media 미연동인데 비트가 섰다');
  });

  test('벤더 미연동이면 신분증·계좌 비트는 서지 않는다', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    const names = new Set(out.methodNames);
    assert.ok(!names.has('ID_DOC_AUTHENTICITY'), '기관 계약 없이 진위확인 비트가 섰다');
    assert.ok(!names.has('BANK_ACCOUNT'), '오픈뱅킹 제휴 없이 계좌 비트가 섰다');
    assert.equal(unpackAttrs(out.attrs).regime, Regime.KR_FSC_NONFACE_SANDBOX);
  });

  // ═══════ 핵심 — 두 정책에 대한 판정이 갈린다 ═══════

  test('★ 우리 마크는 KR VASP 실운영 정책(policyId 1)을 통과하지 못한다', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    assert.notEqual(out.methods & POLICY_KR_VASP, POLICY_KR_VASP,
      '진위확인·계좌 벤더가 없는데 실운영 정책을 통과한다면 거짓말이다');
  });

  test('★ 우리 마크는 파일럿 정책(policyId 2 제안)을 통과한다', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    assert.equal(out.methods & POLICY_PILOT, POLICY_PILOT,
      '실제로 수행한 심사만으로 구성한 정책은 통과해야 한다');
  });

  // ═══════ 제재 대상은 차단된다 ═══════

  test('제재 대상 관할은 DENIED', async () => {
    const out = await runIssuance(
      { ...cleanReq, declared: { ...cleanReq.declared, nationality: 'KP', residence: 'KP' } },
      new KrAdapter(null, null), aml, NOW);
    assert.ok(out.status === 'DENIED' || out.status === 'REVIEW',
      `고위험 관할인데 ${out.status} 로 나왔다`);
  });

  // ═══════ PII 유출 — 알려진 미해결 이슈 ═══════

  /**
   * `ScreeningEvidence` 가 `normalizedName` · `nameTokens` · `romanizedVariants` 를
   * **원문으로** 담는다. 증적은 오프체인이지만, 여기에 PII 가 있으면
   * **삭제권(PIPA/GDPR)과 감사추적이 충돌한다** — 금고에서 원문을 지우는 순간
   * evidenceHash 를 재계산할 수 없어 증적이 무의미해진다.
   * 해시로 바꾸면 증적은 영구 보관하고 금고만 지울 수 있다.
   *
   * → aml/engine.ts 수정 후 `todo` 를 떼고 활성화한다.
   */
  test('증적에 PII 원문이 없다 (실물 엔진)', async () => {
    const out = await runIssuance(cleanReq, new KrAdapter(null, null), aml, NOW);
    if (out.status !== 'ISSUED') return;
    // 로마자 전개도 이름에서 유도되므로 함께 검사한다
    assert.ok(!containsPii(out.evidence, '박서준'), '증적에 이름 원문이 들어 있다');
    assert.ok(!containsPii(out.evidence, 'park seojun'), '증적에 로마자 전개가 원문으로 들어 있다');
  });

  // ═══════ 벤더가 붙으면 실운영 정책도 통과한다 ═══════

  test('벤더 연동 시에는 실운영 정책도 통과한다 — 설계가 막힌 게 아니다', async () => {
    const idVendor: IdDocumentVendor = {
      async verify() {
        return { fullName: '박서준', dateOfBirth: '1988-03-14', docHash: '0xdoc',
                 authenticityChecked: true, faceMatched: true, livenessPassed: true };
      },
    };
    const bankVendor: BankAccountVendor = {
      async verifyHolder() { return { holderName: '박서준', verified: true }; },
    };

    const out = await runIssuance(
      { ...cleanReq, idImage: new Uint8Array([1]), bank: { bankCode: '004', accountNumber: '1' } },
      new KrAdapter(idVendor, bankVendor), aml, NOW);
    assert.equal(out.status, 'ISSUED');
    if (out.status !== 'ISSUED') return;

    assert.equal(out.methods & POLICY_KR_VASP, POLICY_KR_VASP,
      '벤더가 붙으면 실운영 정책을 통과해야 한다 — 통과 못 하면 설계 결함이다');
    assert.equal(unpackAttrs(out.attrs).regime, Regime.KR_FSC_NONFACE);
  });
});
