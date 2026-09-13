import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';

const EVIDENCE_KEY = 'synthetic-evidence-hmac-key-at-least-32-characters';
const TOKEN_KEY_1 = 'synthetic-server-token-key-one-at-least-32-characters';
const TOKEN_KEY_2 = 'synthetic-server-token-key-two-at-least-32-characters';

for (const name of [
  'SERVER_TOKEN_KEY', 'SERVER_TOKEN_KEY_ID', 'SERVER_TOKEN_PREVIOUS_KEY',
  'SERVER_TOKEN_PREVIOUS_KEY_ID', 'SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL',
]) delete process.env[name];
process.env.EVIDENCE_HMAC_KEY = EVIDENCE_KEY;
process.env.SERVER_TOKEN_KEY = TOKEN_KEY_1;
process.env.SERVER_TOKEN_KEY_ID = 'token-k1';

const { codeDigest, codeMatches, open, seal, TokenError, ConfigError } = await import('../lib/kyc-server');

function decryptWithEvidenceKey(token: string): unknown {
  const bytes = Buffer.from(token, 'base64url');
  const key = createHash('sha256').update(`${EVIDENCE_KEY}|proofmark-seal-v1`).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
}

test('PM-T23-01 separates token custody and keeps only an explicitly bounded previous key during rotation', () => {
  const token1 = seal('wallet', { address: `0x${'11'.repeat(20)}`, flowId: 'synthetic-flow' }, 600);
  const challengeDigest = codeDigest('123456');
  assert.throws(() => decryptWithEvidenceKey(token1), 'evidence-key access must not decrypt a server token');

  process.env.SERVER_TOKEN_KEY = TOKEN_KEY_2;
  process.env.SERVER_TOKEN_KEY_ID = 'token-k2';
  process.env.SERVER_TOKEN_PREVIOUS_KEY = TOKEN_KEY_1;
  process.env.SERVER_TOKEN_PREVIOUS_KEY_ID = 'token-k1';
  process.env.SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL = String(Date.now() + 60_000);
  assert.equal(open<{ flowId: string }>('wallet', token1).flowId, 'synthetic-flow');
  assert.equal(codeMatches('123456', challengeDigest), true, 'an in-flight bank challenge must survive the bounded rotation');

  const token2 = seal('wallet', { address: `0x${'22'.repeat(20)}`, flowId: 'rotated-flow' }, 600);
  delete process.env.SERVER_TOKEN_PREVIOUS_KEY;
  delete process.env.SERVER_TOKEN_PREVIOUS_KEY_ID;
  delete process.env.SERVER_TOKEN_PREVIOUS_ACCEPT_UNTIL;
  assert.throws(() => open('wallet', token1), TokenError, 'retired key must no longer validate tokens');
  assert.equal(codeMatches('123456', challengeDigest), false, 'retired challenge key must no longer validate codes');
  assert.equal(open<{ flowId: string }>('wallet', token2).flowId, 'rotated-flow');

  process.env.SERVER_TOKEN_KEY = EVIDENCE_KEY;
  assert.throws(() => seal('wallet', {}, 60), ConfigError, 'an explicitly reused evidence/token secret must fail closed');
});
