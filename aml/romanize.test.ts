import { test } from 'node:test';
import assert from 'node:assert';
import { romanizeVariants, hasHangul } from './romanize.js';

test('북한 지도자 표기가 전개에 포함된다', () => {
  const v = romanizeVariants('김정은').map(s => s.toLowerCase());
  assert.ok(v.includes('kim jong un'), 'kim jong un 누락: ' + v.slice(0,8));
});

test('일반 성씨 관용 표기', () => {
  assert.ok(romanizeVariants('이재명').some(s => s.startsWith('lee')));
  assert.ok(romanizeVariants('박지성').some(s => s.startsWith('park')));
});

test('영/용 충돌 — 둘 다 yong 으로 전개된다 (그래서 뒷받침이 필요하다)', () => {
  const a = romanizeVariants('최영호'), b = romanizeVariants('최용호');
  const inter = a.filter(x => b.includes(x));
  assert.ok(inter.length > 0, '전개 충돌이 재현되어야 한다 — 이게 corroboration 이 필요한 이유');
});

test('한글 판별', () => {
  assert.equal(hasHangul('김정은'), true);
  assert.equal(hasHangul('Kim Jong Un'), false);
});
