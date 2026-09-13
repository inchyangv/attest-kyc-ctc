import { test } from 'node:test';
import assert from 'node:assert/strict';
import importedConfig from '../next.config';

const config = ((importedConfig as unknown as { default?: typeof importedConfig }).default ?? importedConfig);

test('web responses declare the fixed browser security boundary', async () => {
  assert.equal(typeof config.headers, 'function');
  const rules = await config.headers!();
  assert.equal(rules.length, 2); assert.equal(rules[0].source, '/(.*)');
  assert.equal(rules[1].source, '/verify/provider');
  const headers = Object.fromEntries(rules[0].headers.map(item => [item.key.toLowerCase(), item.value]));
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['referrer-policy'], 'no-referrer');
  assert.match(headers['strict-transport-security'], /max-age=31536000/);
  assert.match(headers['permissions-policy'], /camera=\(\)/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(headers['content-security-policy'], /object-src 'none'/);
});
