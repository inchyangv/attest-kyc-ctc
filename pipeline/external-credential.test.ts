import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';

import { Methods } from './methods.js';
import {
  Es256kJwtCredentialAdapter,
  ExternalCredentialError,
  InMemoryCredentialReplayStore,
  type ExternalCredentialAdapterConfig,
  type ExternalCredentialJwtClaims,
  type ExternalCredentialStatusClient,
} from './external-credential.js';

const NOW = 1_800_000_000;
const HMAC_KEY = 'synthetic-t30-credential-id-key-at-least-32-characters';
const issuer = new ethers.Wallet('0x' + '11'.repeat(32));
const otherIssuer = new ethers.Wallet('0x' + '22'.repeat(32));
const subject = new ethers.Wallet('0x' + '33'.repeat(32)).address;
const otherSubject = new ethers.Wallet('0x' + '44'.repeat(32)).address;

const config: ExternalCredentialAdapterConfig = {
  id: 'approved-provider-adapter',
  issuerId: `did:pkh:eip155:1:${issuer.address}`,
  issuerAddress: issuer.address,
  keyId: 'provider-key-2026-09',
  audience: 'proofmark:source:sepolia',
  product: 'approved-individual-kyc',
  environment: 'production',
  publication: { model: 'provider', sourceIssuer: issuer.address },
  assurance: { substantial: 3 },
  regimes: { 'approved-kyc': 1 },
  jurisdictions: { KR: 410 },
  methods: {
    'wallet-control': Methods.WALLET_CONTROL,
    'id-document-authenticity': Methods.ID_DOC_AUTHENTICITY,
    'sanctions-screening': Methods.SANCTIONS_SCREENED,
  },
  requiredChecks: ['wallet-control', 'id-document-authenticity'],
  maxCredentialAgeSeconds: 86_400,
  credentialIdHmacKey: HMAC_KEY,
};

const baseClaims = (patch: Partial<ExternalCredentialJwtClaims> = {}): ExternalCredentialJwtClaims => ({
  iss: config.issuerId,
  aud: config.audience,
  sub: subject,
  jti: ethers.id('synthetic-external-credential-1'),
  iat: NOW - 60,
  exp: NOW + 3_600,
  proofmark: {
    schema: 'proofmark-external-jwt-v1',
    provider: config.id,
    product: config.product,
    environment: 'production',
    assurance: 'substantial',
    regime: 'approved-kyc',
    jurisdiction: 'KR',
    checks: ['wallet-control', 'id-document-authenticity', 'sanctions-screening'],
    evidenceDigest: ethers.id('synthetic-provider-evidence'),
  },
  ...patch,
});

function b64(value: unknown): string {
  const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return bytes.toString('base64url');
}

function signJwt(
  signer: ethers.Wallet,
  claims: ExternalCredentialJwtClaims,
  header: Record<string, unknown> = { alg: 'ES256K', typ: 'JWT', kid: config.keyId },
): string {
  const input = `${b64(header)}.${b64(claims)}`;
  const signature = signer.signingKey.sign(ethers.sha256(ethers.toUtf8Bytes(input)));
  return `${input}.${Buffer.concat([Buffer.from(ethers.getBytes(signature.r)), Buffer.from(ethers.getBytes(signature.s))]).toString('base64url')}`;
}

class Status implements ExternalCredentialStatusClient {
  value: 'active' | 'revoked' | 'expired' | 'unknown' = 'active';
  calls: string[] = [];
  fail = false;
  async status(credentialId: string) {
    this.calls.push(credentialId);
    if (this.fail) throw new Error('synthetic private provider diagnostic');
    return this.value;
  }
}

function fixture(status = new Status()) {
  return { status, adapter: new Es256kJwtCredentialAdapter(config, status, new InMemoryCredentialReplayStore(), () => NOW) };
}

test('PM-T30-01 rejects a validly signed credential for the wrong audience and accepts one exact credential only once', async () => {
  const f = fixture();
  const wrongAudience = signJwt(issuer, baseClaims({ aud: 'another-application' }));
  await assert.rejects(f.adapter.consume(wrongAudience, { wallet: subject }), /EXTERNAL_AUDIENCE_MISMATCH/);

  const token = signJwt(issuer, baseClaims());
  const first = await f.adapter.consume(token, { wallet: subject });
  const replay = await f.adapter.consume(token, { wallet: subject });
  assert.equal(first.status, 'active');
  assert.equal(first.replay, 'fresh');
  assert.equal(replay.status, 'active');
  assert.equal(replay.replay, 'duplicate');
  assert.equal(replay.requestId, first.requestId);
  assert.equal(first.credential.subject, ethers.getAddress(subject));
  assert.equal(first.credential.issuer, issuer.address);
  assert.equal(first.credential.methods, Methods.WALLET_CONTROL | Methods.ID_DOC_AUTHENTICITY | Methods.SANCTIONS_SCREENED);
  assert.equal(first.credential.regime, 1);
  assert.equal(first.credential.jurisdiction, 410);
  assert.equal(first.credential.expiry, NOW + 3_600);
  assert.match(first.credential.attrs, /^0x[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(first).includes(baseClaims().jti.slice(2)), false, 'raw provider credential ID must not enter output');
  assert.deepEqual(f.status.calls, [baseClaims().jti, baseClaims().jti]);
});

test('issuer signature, key ID and configured provider issuer are all pinned', async () => {
  for (const token of [
    signJwt(otherIssuer, baseClaims()),
    signJwt(issuer, baseClaims(), { alg: 'ES256K', typ: 'JWT', kid: 'retired-key' }),
    signJwt(issuer, baseClaims({ iss: `did:pkh:eip155:1:${otherIssuer.address}` })),
  ]) await assert.rejects(fixture().adapter.consume(token, { wallet: subject }), /EXTERNAL_(SIGNATURE_INVALID|HEADER_INVALID|ISSUER_MISMATCH)/);
});

test('subject binding, expiry, future issuance and sandbox/production separation fail closed', async () => {
  const cases: Array<[ExternalCredentialJwtClaims, string, string]> = [
    [baseClaims({ sub: otherSubject }), subject, 'EXTERNAL_SUBJECT_MISMATCH'],
    [baseClaims(), otherSubject, 'EXTERNAL_SUBJECT_MISMATCH'],
    [baseClaims({ exp: NOW }), subject, 'EXTERNAL_CREDENTIAL_EXPIRED'],
    [baseClaims({ iat: NOW + 1 }), subject, 'EXTERNAL_ISSUED_IN_FUTURE'],
    [baseClaims({ proofmark: { ...baseClaims().proofmark, environment: 'sandbox' } }), subject, 'EXTERNAL_ENVIRONMENT_MISMATCH'],
  ];
  for (const [claims, wallet, code] of cases) {
    await assert.rejects(fixture().adapter.consume(signJwt(issuer, claims), { wallet }), new RegExp(code));
  }
});

test('mapping is configured, bounded and does not award bits for unknown checks', async () => {
  const unknown = baseClaims({ proofmark: { ...baseClaims().proofmark, checks: [...baseClaims().proofmark.checks, 'provider-private-score'] } });
  const result = await fixture().adapter.consume(signJwt(issuer, unknown), { wallet: subject });
  assert.equal(result.status, 'active');
  assert.equal(result.credential.methods & Methods.ONCHAIN_EXPOSURE, 0);

  const missing = baseClaims({ proofmark: { ...baseClaims().proofmark, checks: ['wallet-control'] } });
  await assert.rejects(fixture().adapter.consume(signJwt(issuer, missing), { wallet: subject }), /EXTERNAL_REQUIRED_CHECK_MISSING/);
  const assurance = baseClaims({ proofmark: { ...baseClaims().proofmark, assurance: 'unmapped-grade' } });
  await assert.rejects(fixture().adapter.consume(signJwt(issuer, assurance), { wallet: subject }), /EXTERNAL_ASSURANCE_UNSUPPORTED/);
  const jurisdiction = baseClaims({ proofmark: { ...baseClaims().proofmark, jurisdiction: 'US' } });
  await assert.rejects(fixture().adapter.consume(signJwt(issuer, jurisdiction), { wallet: subject }), /EXTERNAL_JURISDICTION_UNSUPPORTED/);

  const mutable = structuredClone(config);
  const pinned = new Es256kJwtCredentialAdapter(mutable, new Status(), new InMemoryCredentialReplayStore(), () => NOW);
  mutable.audience = 'mutated-after-start'; mutable.methods['wallet-control'] = Methods.ONCHAIN_EXPOSURE;
  const unchanged = await pinned.consume(signJwt(issuer, baseClaims()), { wallet: subject });
  assert.equal(unchanged.status, 'active');
  assert.equal(unchanged.credential.methods & Methods.ONCHAIN_EXPOSURE, 0);
});

test('revoked/expired provider state returns a revocation instruction; unknown/error cannot issue', async () => {
  const f = fixture(); const token = signJwt(issuer, baseClaims());
  f.status.value = 'revoked';
  const revoked = await f.adapter.consume(token, { wallet: subject });
  assert.equal(revoked.status, 'revoked');
  assert.equal('credential' in revoked, false);
  f.status.value = 'expired';
  const expired = await f.adapter.consume(token, { wallet: subject });
  assert.equal(expired.status, 'revoked');
  f.status.value = 'unknown';
  await assert.rejects(f.adapter.consume(token, { wallet: subject }), /EXTERNAL_STATUS_UNKNOWN/);
  f.status.fail = true;
  await assert.rejects(f.adapter.consume(token, { wallet: subject }), (error: unknown) =>
    error instanceof ExternalCredentialError && error.code === 'EXTERNAL_PROVIDER_UNAVAILABLE'
      && !error.message.includes('synthetic private provider diagnostic'));
  await assert.rejects(f.adapter.status('customer@example.invalid'), /EXTERNAL_CREDENTIAL_ID_INVALID/);
});

test('strict native payload rejects extra identity fields and normalize cannot trust a caller-built envelope', async () => {
  const claims = { ...baseClaims(), fullName: 'Synthetic Person' } as ExternalCredentialJwtClaims;
  await assert.rejects(fixture().adapter.consume(signJwt(issuer, claims), { wallet: subject }), /EXTERNAL_PAYLOAD_INVALID/);
  await assert.rejects(fixture().adapter.normalize(baseClaims() as never), /EXTERNAL_ENVELOPE_UNAUTHENTICATED/);
});

test('concurrent duplicate claims are atomic and a changed credential reusing jti conflicts', async () => {
  const f = fixture(); const token = signJwt(issuer, baseClaims());
  const results = await Promise.all(Array.from({ length: 20 }, () => f.adapter.consume(token, { wallet: subject })));
  assert.equal(results.filter(result => result.status === 'active' && result.replay === 'fresh').length, 1);
  assert.equal(results.filter(result => result.status === 'active' && result.replay === 'duplicate').length, 19);
  const changed = signJwt(issuer, baseClaims({ exp: NOW + 3_601 }));
  await assert.rejects(f.adapter.consume(changed, { wallet: subject }), /EXTERNAL_REPLAY_CONFLICT/);
});
