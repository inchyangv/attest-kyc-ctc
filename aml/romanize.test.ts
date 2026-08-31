import { test } from 'node:test';
import assert from 'node:assert';
import { romanizeVariants, hasHangul } from './romanize.js';

test('the DPRK leader spelling appears in the expansion', () => {
  const v = romanizeVariants('\uAE40\uC815\uC740').map(s => s.toLowerCase());
  assert.ok(v.includes('kim jong un'), 'kim jong un missing: ' + v.slice(0,8));
});

test('common surname spellings', () => {
  assert.ok(romanizeVariants('\uC774\uC7AC\uBA85').some(s => s.startsWith('lee')));
  assert.ok(romanizeVariants('\uBC15\uC9C0\uC131').some(s => s.startsWith('park')));
});

test('yeong and yong both expand to yong, which is why corroboration is required', () => {
  const a = romanizeVariants('\uCD5C\uC601\uD638'), b = romanizeVariants('\uCD5C\uC6A9\uD638');
  const inter = a.filter(x => b.includes(x));
  assert.ok(inter.length > 0, 'the expansion collision must reproduce; it is the reason corroboration exists');
});

test('detects Hangul', () => {
  assert.equal(hasHangul('\uAE40\uC815\uC740'), true);
  assert.equal(hasHangul('Kim Jong Un'), false);
});
