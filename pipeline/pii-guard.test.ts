import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { containsPii } from './pii-guard.js';

describe('PII 탐지기 — 정규화 형태를 가로지른다', () => {
  test('NFC 로 저장된 한글을 잡는다', () => {
    assert.ok(containsPii({ n: '박서준'.normalize('NFC') }, '박서준'));
  });

  test('★ NFD(자모 분해)로 저장된 한글도 잡는다', () => {
    // 실제로 AML 엔진이 이 형태로 저장했고, 순진한 includes 가 못 잡았다
    const decomposed = '박서준'.normalize('NFD');
    assert.ok(!JSON.stringify({ n: decomposed }).includes('박서준'), '전제: 단순 includes 는 못 잡는다');
    assert.ok(containsPii({ n: decomposed }, '박서준'), '탐지기는 잡아야 한다');
  });

  test('대소문자 차이를 흡수한다', () => {
    assert.ok(containsPii({ n: 'PARK SEOJUN' }, 'park seojun'));
  });

  test('무관한 값은 잡지 않는다', () => {
    assert.ok(!containsPii({ n: '0xabc', h: '0x' + '11'.repeat(32) }, '박서준'));
  });
});
