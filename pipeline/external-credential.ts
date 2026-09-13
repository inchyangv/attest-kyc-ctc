import { createHmac } from 'node:crypto';
import { ethers } from 'ethers';

import { packAttrs, SUPPORTED_METHODS } from './attrs.js';

export const EXTERNAL_CREDENTIAL_SCHEMA = 'proofmark-external-jwt-v1' as const;

export interface ExternalCredentialJwtClaims {
  iss: string;
  aud: string;
  sub: string;
  /** Opaque provider identifier. This profile requires bytes32 so identity data cannot be used. */
  jti: string;
  iat: number;
  exp: number;
  proofmark: {
    schema: typeof EXTERNAL_CREDENTIAL_SCHEMA;
    provider: string;
    product: string;
    environment: 'production' | 'sandbox';
    assurance: string;
    regime: string;
    jurisdiction: string;
    checks: string[];
    evidenceDigest: string;
  };
}

export interface ExternalCredentialAdapterConfig {
  id: string;
  issuerId: string;
  /** Address recovered from the provider's ES256K compact JWS signature. */
  issuerAddress: string;
  keyId: string;
  audience: string;
  product: string;
  environment: 'production' | 'sandbox';
  publication: {
    model: 'provider' | 'adapter';
    /** Exact Source issuer that an independent consumer must pin. */
    sourceIssuer: string;
  };
  assurance: Record<string, number>;
  regimes: Record<string, number>;
  jurisdictions: Record<string, number>;
  /** One explicit provider check maps to one Proofmark method bit. */
  methods: Record<string, number>;
  requiredChecks: string[];
  maxCredentialAgeSeconds: number;
  credentialIdHmacKey: string;
}

export interface ExternalCredentialEnvelopeV1 extends ExternalCredentialJwtClaims {
  credentialDigest: string;
}

export interface NormalizedExternalCredentialV1 {
  schema: 'proofmark-normalized-v1';
  subject: string;
  issuer: string;
  methods: number;
  assurance: number;
  regime: number;
  jurisdiction: number;
  issuedAt: number;
  expiry: number;
  providerCredentialIdHash: string;
  evidenceHash: string;
  requestId: string;
  attrs: string;
  claimsRoot: string;
}

export interface ExternalCredentialStatusClient {
  status(credentialId: string): Promise<'active' | 'revoked' | 'expired' | 'unknown'>;
}

export interface ExternalCredentialReplayStore {
  /** Must atomically distinguish a byte-identical retry from a reused provider credential ID. */
  claim(requestId: string, credentialDigest: string): Promise<'fresh' | 'duplicate' | 'conflict'>;
}

export class InMemoryCredentialReplayStore implements ExternalCredentialReplayStore {
  private readonly claims = new Map<string, string>();
  async claim(requestId: string, credentialDigest: string): Promise<'fresh' | 'duplicate' | 'conflict'> {
    const existing = this.claims.get(requestId);
    if (existing === undefined) {
      this.claims.set(requestId, credentialDigest);
      return 'fresh';
    }
    return existing === credentialDigest ? 'duplicate' : 'conflict';
  }
}

export class ExternalCredentialError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExternalCredentialError';
  }
}

const fail = (code: string): never => { throw new ExternalCredentialError(code); };
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const safeString = (value: unknown, max = 160): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function decodeBase64Url(value: string, maxBytes: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return fail('EXTERNAL_TOKEN_INVALID');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length < 1 || decoded.length > maxBytes || decoded.toString('base64url') !== value) return fail('EXTERNAL_TOKEN_INVALID');
  return decoded;
}

function parseJsonSegment(value: string, maxBytes: number): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(value, maxBytes));
    const parsed: unknown = JSON.parse(text);
    if (!object(parsed)) return fail('EXTERNAL_TOKEN_INVALID');
    return parsed;
  } catch (error) {
    if (error instanceof ExternalCredentialError) throw error;
    return fail('EXTERNAL_TOKEN_INVALID');
  }
}

function recoverSigner(input: string, signatureSegment: string): string {
  const bytes = decodeBase64Url(signatureSegment, 64);
  if (bytes.length !== 64) return fail('EXTERNAL_SIGNATURE_INVALID');
  const r = ethers.hexlify(bytes.subarray(0, 32));
  const s = ethers.hexlify(bytes.subarray(32));
  const digest = ethers.sha256(ethers.toUtf8Bytes(input));
  const recovered = new Set<string>();
  try {
    for (const yParity of [0, 1] as const) {
      recovered.add(ethers.recoverAddress(digest, ethers.Signature.from({ r, s, yParity })).toLowerCase());
    }
  } catch { return fail('EXTERNAL_SIGNATURE_INVALID'); }
  if (recovered.size !== 2) return fail('EXTERNAL_SIGNATURE_INVALID');
  return [...recovered].join(',');
}

function validateConfig(config: ExternalCredentialAdapterConfig): void {
  if (!object(config) || !safeString(config.id, 80) || !safeString(config.issuerId, 200)
    || !safeString(config.keyId, 160) || !safeString(config.audience, 200) || !safeString(config.product, 120)
    || !ethers.isAddress(config.issuerAddress) || same(config.issuerAddress, ethers.ZeroAddress)
    || !object(config.publication) || !ethers.isAddress(config.publication.sourceIssuer)
    || same(config.publication.sourceIssuer, ethers.ZeroAddress)
    || !['provider', 'adapter'].includes(config.publication.model)
    || (config.publication.model === 'provider' && !same(config.publication.sourceIssuer, config.issuerAddress))
    || !['production', 'sandbox'].includes(config.environment)
    || !Number.isSafeInteger(config.maxCredentialAgeSeconds) || config.maxCredentialAgeSeconds < 1
    || config.maxCredentialAgeSeconds > 31_536_000 || typeof config.credentialIdHmacKey !== 'string'
    || config.credentialIdHmacKey.length < 32 || !object(config.assurance) || !object(config.regimes)
    || !object(config.jurisdictions) || !object(config.methods) || !Array.isArray(config.requiredChecks)) {
    fail('EXTERNAL_CONFIG_INVALID');
  }
  for (const value of Object.values(config.assurance)) if (!Number.isSafeInteger(value) || value < 1 || value > 5) fail('EXTERNAL_CONFIG_INVALID');
  for (const value of Object.values(config.regimes)) if (!Number.isSafeInteger(value) || (value !== 1 && value !== 2)) fail('EXTERNAL_CONFIG_INVALID');
  for (const [country, value] of Object.entries(config.jurisdictions)) {
    if (!/^[A-Z]{2}$/.test(country) || !Number.isSafeInteger(value) || value < 1 || value > 999) fail('EXTERNAL_CONFIG_INVALID');
  }
  for (const [check, value] of Object.entries(config.methods)) {
    if (!safeString(check, 100) || !Number.isSafeInteger(value) || value < 1 || (value & (value - 1)) !== 0
      || (value & ~SUPPORTED_METHODS) !== 0) fail('EXTERNAL_CONFIG_INVALID');
  }
  if (!Object.keys(config.assurance).length || !Object.keys(config.regimes).length || !Object.keys(config.jurisdictions).length
    || !Object.keys(config.methods).length || !config.requiredChecks.length
    || new Set(config.requiredChecks).size !== config.requiredChecks.length
    || config.requiredChecks.some(check => !safeString(check, 100) || !Object.hasOwn(config.methods, check))) fail('EXTERNAL_CONFIG_INVALID');
  for (const [name, regime] of Object.entries(config.regimes)) {
    if (!safeString(name, 100) || (config.environment === 'production' ? regime !== 1 : regime !== 2)) fail('EXTERNAL_CONFIG_INVALID');
  }
}

/**
 * Strict ES256K compact-JWS profile for a provider-native credential boundary.
 *
 * It authenticates bytes issued by the configured external key. It never accepts a caller-built
 * normalized envelope. Provider selection, legal reuse/publication rights, status HTTP semantics,
 * durable replay storage and Source authorization remain explicit deployment inputs.
 */
export class Es256kJwtCredentialAdapter {
  readonly id: string;
  private readonly authenticated = new WeakSet<object>();
  private readonly config: ExternalCredentialAdapterConfig;
  constructor(
    config: ExternalCredentialAdapterConfig,
    private readonly statusClient: ExternalCredentialStatusClient,
    private readonly replayStore: ExternalCredentialReplayStore,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    validateConfig(config);
    if (!statusClient || typeof statusClient.status !== 'function' || !replayStore || typeof replayStore.claim !== 'function') fail('EXTERNAL_CONFIG_INVALID');
    this.config = Object.freeze({ ...config, publication: Object.freeze({ ...config.publication }),
      assurance: Object.freeze({ ...config.assurance }), regimes: Object.freeze({ ...config.regimes }),
      jurisdictions: Object.freeze({ ...config.jurisdictions }), methods: Object.freeze({ ...config.methods }),
      requiredChecks: Object.freeze([...config.requiredChecks]) }) as ExternalCredentialAdapterConfig;
    this.id = this.config.id;
  }

  async authenticate(rawCredential: unknown, context: { wallet: string }): Promise<ExternalCredentialEnvelopeV1> {
    if (typeof rawCredential !== 'string' || rawCredential.length < 16 || rawCredential.length > 32_768
      || !context || !ethers.isAddress(context.wallet) || same(context.wallet, ethers.ZeroAddress)) fail('EXTERNAL_TOKEN_INVALID');
    const token = rawCredential as string;
    const segments = token.split('.');
    if (segments.length !== 3) fail('EXTERNAL_TOKEN_INVALID');
    const header = parseJsonSegment(segments[0], 2_048);
    if (!exactKeys(header, ['alg', 'typ', 'kid']) || header.alg !== 'ES256K' || header.typ !== 'JWT' || header.kid !== this.config.keyId) {
      fail('EXTERNAL_HEADER_INVALID');
    }
    const recovered = recoverSigner(`${segments[0]}.${segments[1]}`, segments[2]);
    if (!recovered.split(',').some(address => same(address, this.config.issuerAddress))) fail('EXTERNAL_SIGNATURE_INVALID');

    const value = parseJsonSegment(segments[1], 16_384);
    if (!exactKeys(value, ['iss', 'aud', 'sub', 'jti', 'iat', 'exp', 'proofmark']) || !object(value.proofmark)) {
      fail('EXTERNAL_PAYLOAD_INVALID');
    }
    const proof = value.proofmark as Record<string, unknown>;
    if (!exactKeys(proof, ['schema', 'provider', 'product', 'environment', 'assurance', 'regime', 'jurisdiction', 'checks', 'evidenceDigest'])) {
      fail('EXTERNAL_PAYLOAD_INVALID');
    }
    if (value.iss !== this.config.issuerId) fail('EXTERNAL_ISSUER_MISMATCH');
    if (value.aud !== this.config.audience) fail('EXTERNAL_AUDIENCE_MISMATCH');
    if (typeof value.sub !== 'string' || !ethers.isAddress(value.sub) || !same(value.sub, context.wallet)) fail('EXTERNAL_SUBJECT_MISMATCH');
    if (!ethers.isHexString(value.jti, 32) || same(value.jti, ethers.ZeroHash)) fail('EXTERNAL_CREDENTIAL_ID_INVALID');
    if (!Number.isSafeInteger(value.iat) || (value.iat as number) < 1 || !Number.isSafeInteger(value.exp)
      || (value.exp as number) <= (value.iat as number)) fail('EXTERNAL_TIME_INVALID');
    const observed = this.now();
    if (!Number.isSafeInteger(observed) || observed < 1) fail('EXTERNAL_CLOCK_INVALID');
    if ((value.iat as number) > observed) fail('EXTERNAL_ISSUED_IN_FUTURE');
    if ((value.exp as number) <= observed || (value.iat as number) + this.config.maxCredentialAgeSeconds <= observed) fail('EXTERNAL_CREDENTIAL_EXPIRED');
    if (proof.schema !== EXTERNAL_CREDENTIAL_SCHEMA || proof.provider !== this.config.id || proof.product !== this.config.product
      || !safeString(proof.assurance, 100) || !safeString(proof.regime, 100)
      || typeof proof.jurisdiction !== 'string' || !/^[A-Z]{2}$/.test(proof.jurisdiction)
      || !Array.isArray(proof.checks) || proof.checks.length > 64 || proof.checks.some(check => !safeString(check, 100))
      || new Set(proof.checks as string[]).size !== proof.checks.length || !ethers.isHexString(proof.evidenceDigest, 32)
      || same(proof.evidenceDigest as string, ethers.ZeroHash)) fail('EXTERNAL_PAYLOAD_INVALID');
    if (proof.environment !== this.config.environment) fail('EXTERNAL_ENVIRONMENT_MISMATCH');

    const envelope: ExternalCredentialEnvelopeV1 = {
      iss: value.iss as string, aud: value.aud as string, sub: ethers.getAddress(value.sub as string), jti: value.jti as string,
      iat: value.iat as number, exp: value.exp as number,
      proofmark: {
        schema: EXTERNAL_CREDENTIAL_SCHEMA, provider: proof.provider as string, product: proof.product as string,
        environment: proof.environment as 'production' | 'sandbox', assurance: proof.assurance as string,
        regime: proof.regime as string, jurisdiction: proof.jurisdiction as string,
        checks: [...proof.checks as string[]], evidenceDigest: proof.evidenceDigest as string,
      },
      credentialDigest: ethers.keccak256(ethers.toUtf8Bytes(token)),
    };
    this.authenticated.add(envelope);
    return envelope;
  }

  async normalize(envelope: ExternalCredentialEnvelopeV1): Promise<NormalizedExternalCredentialV1> {
    if (!object(envelope) || !this.authenticated.has(envelope)) fail('EXTERNAL_ENVELOPE_UNAUTHENTICATED');
    if (!Object.hasOwn(this.config.assurance, envelope.proofmark.assurance)) fail('EXTERNAL_ASSURANCE_UNSUPPORTED');
    const assurance = this.config.assurance[envelope.proofmark.assurance];
    if (!Object.hasOwn(this.config.regimes, envelope.proofmark.regime)) fail('EXTERNAL_REGIME_UNSUPPORTED');
    const regime = this.config.regimes[envelope.proofmark.regime];
    if (!Object.hasOwn(this.config.jurisdictions, envelope.proofmark.jurisdiction)) fail('EXTERNAL_JURISDICTION_UNSUPPORTED');
    const jurisdiction = this.config.jurisdictions[envelope.proofmark.jurisdiction];
    for (const required of this.config.requiredChecks) {
      if (!envelope.proofmark.checks.includes(required)) fail('EXTERNAL_REQUIRED_CHECK_MISSING');
    }
    const methods = envelope.proofmark.checks.reduce((mask, check) => mask
      | (Object.hasOwn(this.config.methods, check) ? this.config.methods[check] : 0), 0);
    const expiry = Math.min(envelope.exp, envelope.iat + this.config.maxCredentialAgeSeconds);
    const providerCredentialIdHash = '0x' + createHmac('sha256', this.config.credentialIdHmacKey)
      .update(`${this.config.id}\0${envelope.jti}`).digest('hex');
    const requestId = ethers.keccak256(ethers.concat([
      ethers.getBytes(providerCredentialIdHash), ethers.getBytes(ethers.id(this.config.publication.sourceIssuer)),
    ]));
    const attrs = packAttrs({ kind: 1, assurance, regime, jurisdiction, methods, issuedAt: envelope.iat, expiry, epoch: 0 });
    return {
      schema: 'proofmark-normalized-v1', subject: envelope.sub, issuer: ethers.getAddress(this.config.publication.sourceIssuer),
      methods, assurance, regime, jurisdiction, issuedAt: envelope.iat, expiry, providerCredentialIdHash,
      evidenceHash: envelope.credentialDigest, requestId, attrs, claimsRoot: ethers.ZeroHash,
    };
  }

  async status(credentialId: string): Promise<'active' | 'revoked' | 'expired' | 'unknown'> {
    if (!ethers.isHexString(credentialId, 32) || same(credentialId, ethers.ZeroHash)) fail('EXTERNAL_CREDENTIAL_ID_INVALID');
    try {
      const status = await this.statusClient.status(credentialId);
      if (!['active', 'revoked', 'expired', 'unknown'].includes(status)) fail('EXTERNAL_PROVIDER_RESPONSE_INVALID');
      return status;
    } catch (error) {
      if (error instanceof ExternalCredentialError) throw error;
      return fail('EXTERNAL_PROVIDER_UNAVAILABLE');
    }
  }

  async consume(rawCredential: unknown, context: { wallet: string }): Promise<
    | { status: 'active'; replay: 'fresh' | 'duplicate'; requestId: string; credential: NormalizedExternalCredentialV1 }
    | { status: 'revoked'; requestId: string; subject: string; providerCredentialIdHash: string; evidenceHash: string }
  > {
    const envelope = await this.authenticate(rawCredential, context);
    const credential = await this.normalize(envelope);
    const current = await this.status(envelope.jti);
    if (current === 'unknown') fail('EXTERNAL_STATUS_UNKNOWN');
    if (current === 'revoked' || current === 'expired') {
      return { status: 'revoked', requestId: credential.requestId, subject: credential.subject,
        providerCredentialIdHash: credential.providerCredentialIdHash, evidenceHash: credential.evidenceHash };
    }
    if (credential.expiry <= this.now()) fail('EXTERNAL_CREDENTIAL_EXPIRED');
    let replay: 'fresh' | 'duplicate' | 'conflict';
    try { replay = await this.replayStore.claim(credential.requestId, credential.evidenceHash); }
    catch (error) {
      if (error instanceof ExternalCredentialError) throw error;
      return fail('EXTERNAL_REPLAY_UNAVAILABLE');
    }
    if (!['fresh', 'duplicate', 'conflict'].includes(replay)) fail('EXTERNAL_REPLAY_STORE_INVALID');
    if (replay === 'conflict') fail('EXTERNAL_REPLAY_CONFLICT');
    return { status: 'active', replay: replay as 'fresh' | 'duplicate', requestId: credential.requestId, credential };
  }
}
