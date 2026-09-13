import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import type { NextConfig } from 'next';

const config = createRequire(import.meta.url)('../next.config.ts').default as NextConfig;

test('Sumsub script/frame and capture permissions are scoped to the provider document', async () => {
  const rules = await config.headers!();
  const defaults = rules.find((rule) => rule.source === '/(.*)')!;
  const provider = rules.find((rule) => rule.source === '/verify/provider')!;
  assert.ok(defaults);
  assert.ok(provider);
  assert.ok(rules.indexOf(provider) > rules.indexOf(defaults), 'Next applies the last matching header');
  const base = Object.fromEntries(defaults.headers.map(({ key, value }) => [key, value]));
  const scoped = { ...base, ...Object.fromEntries(provider.headers.map(({ key, value }) => [key, value])) };
  assert.equal(base['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  assert.doesNotMatch(base['Content-Security-Policy'], /sumsub/);
  assert.match(scoped['Content-Security-Policy'], /script-src 'self' 'unsafe-inline' https:\/\/static\.sumsub\.com;/);
  assert.match(scoped['Content-Security-Policy'], /frame-src https:\/\/api\.sumsub\.com;/);
  assert.doesNotMatch(scoped['Content-Security-Policy'], /\*\.sumsub|unsafe-eval/);
  assert.match(scoped['Permissions-Policy'], /camera=\(self "https:\/\/api\.sumsub\.com"\)/);
  assert.match(scoped['Permissions-Policy'], /microphone=\(self "https:\/\/api\.sumsub\.com"\)/);
  assert.match(scoped['Permissions-Policy'], /geolocation=\(\), payment=\(\), usb=\(\)/);
  assert.equal(scoped['X-Frame-Options'], 'DENY');
  assert.match(scoped['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.deepEqual(rules.filter((rule) => rule.headers.some((header) => /sumsub/.test(header.value))).map((rule) => rule.source), ['/verify/provider']);
});
