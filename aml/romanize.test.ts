import { test } from 'node:test';
import assert from 'node:assert';
import { romanizeVariants, hasHangul } from './romanize.js';

test('the DPRK leader spelling appears in the expansion', () => {
  const v = romanizeVariants('김정은').map(s => s.toLowerCase());
  assert.ok(v.includes('kim jong un'), 'kim jong un missing: ' + v.slice(0,8));
});

test('common surname spellings', () => {
  assert.ok(romanizeVariants('이재명').some(s => s.startsWith('lee')));
  assert.ok(romanizeVariants('박지성').some(s => s.startsWith('park')));
});

test('yeong and yong both expand to yong, which is why corroboration is required', () => {
  const a = romanizeVariants('최영호'), b = romanizeVariants('최용호');
  const inter = a.filter(x => b.includes(x));
  assert.ok(inter.length > 0, 'the expansion collision must reproduce; it is the reason corroboration exists');
});

test('detects Hangul', () => {
  assert.equal(hasHangul('김정은'), true);
  assert.equal(hasHangul('Kim Jong Un'), false);
});
