import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { containsPii } from './pii-guard.js';

describe('PII detector across normal forms', () => {
  test('catches Hangul stored as NFC', () => {
    assert.ok(containsPii({ n: '\uBC15\uC11C\uC900'.normalize('NFC') }, '\uBC15\uC11C\uC900'));
  });

  test('catches Hangul stored as NFD, decomposed into jamo', () => {
    // the AML engine stored it in this form, and a naive includes missed it
    const decomposed = '\uBC15\uC11C\uC900'.normalize('NFD');
    assert.ok(!JSON.stringify({ n: decomposed }).includes('\uBC15\uC11C\uC900'), 'premise: a plain includes does not catch it');
    assert.ok(containsPii({ n: decomposed }, '\uBC15\uC11C\uC900'), 'the detector must catch it');
  });

  test('absorbs case differences', () => {
    assert.ok(containsPii({ n: 'PARK SEOJUN' }, 'park seojun'));
  });

  test('does not fire on unrelated values', () => {
    assert.ok(!containsPii({ n: '0xabc', h: '0x' + '11'.repeat(32) }, '\uBC15\uC11C\uC900'));
  });
});
