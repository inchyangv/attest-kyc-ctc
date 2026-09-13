import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { MethodName } from '../methods.js';

export type SumsubEnvironment = 'sandbox' | 'production';
export type SumsubDecision = 'not-started' | 'review' | 'approved' | 'rejected';

export interface SumsubConfig {
  environment: SumsubEnvironment;
  appToken: string;
  secretKey: string;
  webhookSecret: string;
  levelName: string;
  processingRecipient: string;
  apiBaseUrl?: string;
  /** Only permits loopback HTTP for an injected local conformance server. Never valid in production. */
  localFixture?: boolean;
  sdkTokenTtlSeconds?: number;
  requestTimeoutMs?: number;
  maxWebhookAgeMs?: number;
  evidenceHmacKey: string;
}

export interface SumsubSubjectBinding {
  walletAddress: string;
  flowId: string;
  externalUserId: string;
  processingPolicyFingerprint: string;
  retentionPolicyFingerprint: string;
}

export interface SumsubEvidenceCandidate {
  schema: 'proofmark-sumsub-evidence-v1';
  provider: 'sumsub';
  environment: SumsubEnvironment;
  /** REST responses do not declare sandboxMode; signed callbacks do. Never an issuance grant. */
  environmentEvidence: 'configured-credentials' | 'signed-webhook';
  subject: string;
  flowIdHash: string;
  externalUserIdHash: string;
  applicantIdHash: string;
  inspectionIdHash: string | null;
  levelName: string;
  methodMapping: 'pending-step-evidence';
  methods: number;
  methodNames: MethodName[];
  /** Intentionally null until approved-document step evidence is integrated. Applicant profile country is not enough. */
  jurisdictionAlpha3: null;
  jurisdiction: number | null;
  decision: SumsubDecision;
  reviewStatus: string;
  reviewAnswer: 'GREEN' | 'RED' | null;
  reviewRejectType: 'FINAL' | 'RETRY' | null;
  observedAt: number;
  providerReviewedAt: number | null;
  webhookFence: { eventAt: number; type: SumsubWebhook['type']; reason: 'ONGOING_REVIEW' | 'PROVIDER_REJECTION' } | null;
  processingPolicyFingerprint: string;
  retentionPolicyFingerprint: string;
  evidenceHash: string;
}

export interface SumsubWebhook {
  applicantId: string;
  externalUserId: string;
  type: 'applicantCreated' | 'applicantPending' | 'applicantOnHold' | 'applicantReviewed';
  createdAtMs: number;
  digest: string;
  sandboxMode: boolean;
  /** Manual Webhook Manager delivery. It is authenticated but must never mutate applicant state. */
  testMode: boolean;
  reviewStatus?: string;
  reviewMode?: 'ongoingAml' | 'ongoingDocExpired';
  reviewAnswer?: 'GREEN' | 'RED';
  reviewRejectType?: 'FINAL' | 'RETRY';
}

export class SumsubError extends Error {
  constructor(readonly code: string, readonly status = 502) {
    super(code);
    this.name = 'SumsubError';
  }
}

const fail = (code: string, status = 502): never => { throw new SumsubError(code, status); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safe = (value: unknown, max = 256): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,255}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,255}$/;
const WALLET = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^[0-9a-fA-F]{64}$/;
const APPLICANT_ID = /^[0-9a-z]{24}$/;
const WEBHOOK_TYPES = new Set(['applicantCreated', 'applicantPending', 'applicantOnHold', 'applicantReviewed']);
const REVIEW_STATUSES = new Set(['init', 'pending', 'queued', 'awaitingService', 'awaitingUser', 'onHold', 'prechecked', 'completed']);
function configSnapshot(input: SumsubConfig): Readonly<Required<Omit<SumsubConfig, 'apiBaseUrl' | 'localFixture'>> & Pick<SumsubConfig, 'apiBaseUrl' | 'localFixture'>> {
  if (!input || typeof input !== 'object') fail('SUMSUB_CONFIG_INVALID', 500);
  let base: URL;
  try { base = new URL(input.apiBaseUrl ?? 'https://api.sumsub.com'); }
  catch { return fail('SUMSUB_CONFIG_INVALID', 500); }
  const local = base.protocol === 'http:' && (base.hostname === '127.0.0.1' || base.hostname === '::1');
  if (!input || !['sandbox', 'production'].includes(input.environment) || !safe(input.appToken, 512)
    || !safe(input.secretKey, 512) || !safe(input.webhookSecret, 512) || input.secretKey === input.webhookSecret
    || !safe(input.levelName, 128) || !ID.test(input.levelName) || !safe(input.processingRecipient, 128)
    || !REFERENCE.test(input.processingRecipient) || !safe(input.evidenceHmacKey, 512)
    || input.evidenceHmacKey.length < 32 || input.evidenceHmacKey === input.secretKey || input.evidenceHmacKey === input.webhookSecret
  ) fail('SUMSUB_CONFIG_INVALID', 500);
  const expectedPrefix = input.environment === 'sandbox' ? 'pm-sbx-' : 'pm-prd-';
  if ((local && (!input.localFixture || input.environment !== 'sandbox'))
    || (!local && (input.localFixture || base.protocol !== 'https:' || base.hostname !== 'api.sumsub.com'))
    || base.username || base.password || base.search || base.hash || base.pathname !== '/') fail('SUMSUB_ENVIRONMENT_INVALID', 500);
  const ttl = input.sdkTokenTtlSeconds ?? 600;
  const timeout = input.requestTimeoutMs ?? 10_000;
  const webhookAge = input.maxWebhookAgeMs ?? 10 * 60_000;
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 600 || !Number.isSafeInteger(timeout) || timeout < 100 || timeout > 30_000
    || !Number.isSafeInteger(webhookAge) || webhookAge < 30_000 || webhookAge > 24 * 60 * 60_000) fail('SUMSUB_CONFIG_INVALID', 500);
  return Object.freeze({ ...input, apiBaseUrl: base.toString(), localFixture: !!input.localFixture,
    sdkTokenTtlSeconds: ttl, requestTimeoutMs: timeout, maxWebhookAgeMs: webhookAge,
    externalUserIdPrefix: expectedPrefix } as never);
}

function parseJson(text: string): Record<string, unknown> {
  try { const value: unknown = JSON.parse(text); return object(value) ? value : fail('SUMSUB_RESPONSE_INVALID'); }
  catch (error) { if (error instanceof SumsubError) throw error; return fail('SUMSUB_RESPONSE_INVALID'); }
}

async function boundedText(response: Response, maxBytes = 256 * 1024): Promise<string> {
  if (!response.body) return fail('SUMSUB_RESPONSE_INVALID');
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) return fail('SUMSUB_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const output = new Uint8Array(maxBytes); let size = 0; let chunks = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      if (++chunks > 4096 || value.byteLength > maxBytes - size) return fail('SUMSUB_RESPONSE_INVALID');
      output.set(value, size); size += value.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(output.subarray(0, size));
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof SumsubError) throw error; return fail('SUMSUB_RESPONSE_INVALID');
  }
  finally { try { reader.releaseLock(); } catch { /* response already closed */ } }
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const utcWithoutZone = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  const normalized = utcWithoutZone
    ? `${utcWithoutZone[1]}-${utcWithoutZone[2]}-${utcWithoutZone[3]}T${utcWithoutZone[4]}:${utcWithoutZone[5]}:${utcWithoutZone[6]}.${(utcWithoutZone[7] ?? '0').padEnd(3, '0')}Z`
    : value.replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function webhookTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return null;
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7]}Z`;
  const parsed = Date.parse(normalized);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function keyedHash(key: string, domain: string, value: string): string {
  return `0x${createHmac('sha256', key).update(`proofmark-sumsub-v1\0${domain}\0${value}`).digest('hex')}`;
}

function withEvidenceHash(value: Omit<SumsubEvidenceCandidate, 'evidenceHash'>): SumsubEvidenceCandidate {
  return { ...value, evidenceHash: `0x${createHash('sha256').update(`proofmark-sumsub-evidence-v1\0${JSON.stringify(value)}`).digest('hex')}` };
}

/** Signed callbacks may only make an observation less permissive. A GREEN callback still waits
 * for the authenticated status API; pending/ongoing/rejected callbacks fence stale REST reads. */
export function applySumsubWebhookFence(current: SumsubEvidenceCandidate, webhook: SumsubWebhook): SumsubEvidenceCandidate {
  let reason: SumsubEvidenceCandidate['webhookFence'] = null;
  let decision = current.decision;
  if (webhook.type === 'applicantPending' || webhook.type === 'applicantOnHold'
    || (webhook.reviewStatus && webhook.reviewStatus !== 'completed') || webhook.reviewMode) {
    decision = 'review'; reason = { eventAt: webhook.createdAtMs, type: webhook.type, reason: 'ONGOING_REVIEW' };
  } else if (webhook.reviewAnswer === 'RED') {
    decision = webhook.reviewRejectType === 'FINAL' ? 'rejected' : 'review';
    reason = { eventAt: webhook.createdAtMs, type: webhook.type, reason: 'PROVIDER_REJECTION' };
  }
  const { evidenceHash: _, ...base } = current;
  return withEvidenceHash({ ...base, environmentEvidence: 'signed-webhook', decision,
    methods: 0, methodNames: [], webhookFence: reason ?? current.webhookFence });
}

/** Hold a prior callback fence until a provider review timestamp proves the status read is at
 * least as new. Missing provider timestamps are not allowed to clear an ongoing-AML fence. */
export function retainSumsubWebhookFence(current: SumsubEvidenceCandidate, previous?: SumsubEvidenceCandidate): SumsubEvidenceCandidate {
  const fence = previous?.webhookFence;
  if (!fence || current.providerReviewedAt !== null && current.providerReviewedAt >= fence.eventAt) return current;
  const { evidenceHash: _, ...base } = current;
  return withEvidenceHash({ ...base, decision: previous!.decision, methods: 0, methodNames: [], webhookFence: fence });
}

export class SumsubClient {
  readonly environment: SumsubEnvironment;
  readonly levelName: string;
  readonly processingRecipient: string;
  readonly sdkTokenTtlSeconds: number;
  readonly maxWebhookAgeMs: number;
  readonly externalUserIdPrefix: string;
  private readonly config: ReturnType<typeof configSnapshot> & { externalUserIdPrefix: string };

  constructor(input: SumsubConfig, private readonly request: typeof fetch = fetch, private readonly now = () => Date.now()) {
    this.config = configSnapshot(input) as typeof this.config;
    this.environment = this.config.environment; this.levelName = this.config.levelName;
    this.processingRecipient = this.config.processingRecipient; this.sdkTokenTtlSeconds = this.config.sdkTokenTtlSeconds;
    this.maxWebhookAgeMs = this.config.maxWebhookAgeMs; this.externalUserIdPrefix = this.config.externalUserIdPrefix;
  }

  makeExternalUserId(walletAddress: string, flowId: string): string {
    if (!WALLET.test(walletAddress) || !safe(flowId, 128)) return fail('SUMSUB_SUBJECT_INVALID', 400);
    const digest = createHmac('sha256', this.config.evidenceHmacKey)
      .update(`proofmark-sumsub-external-user-v1\0${this.environment}\0${walletAddress.toLowerCase()}\0${flowId}`).digest('base64url');
    return `${this.externalUserIdPrefix}${digest}`;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: string): Promise<Record<string, unknown>> {
    if (!path.startsWith('/') || path.includes('\n') || path.includes('\r')) return fail('SUMSUB_REQUEST_INVALID', 500);
    const seconds = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(seconds) || seconds < 1) return fail('SUMSUB_CLOCK_INVALID', 500);
    const signature = createHmac('sha256', this.config.secretKey).update(`${seconds}${method}${path}${body ?? ''}`).digest('hex');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    let response: Response | undefined;
    try {
      response = await this.request(new URL(path, this.config.apiBaseUrl), {
        method, body, redirect: 'manual', cache: 'no-store', credentials: 'omit', signal: controller.signal,
        headers: { 'accept': 'application/json', 'content-type': 'application/json',
          'x-app-token': this.config.appToken, 'x-app-access-ts': String(seconds), 'x-app-access-sig': signature },
      });
      const text = await boundedText(response);
      if (!response.ok || response.redirected || response.status < 200 || response.status >= 300) return fail('SUMSUB_UNAVAILABLE', 503);
      return parseJson(text);
    } catch (error) {
      if (error instanceof SumsubError) throw error;
      return fail('SUMSUB_UNAVAILABLE', 503);
    } finally {
      clearTimeout(timer);
      if (controller.signal.aborted) void response?.body?.cancel().catch(() => {});
    }
  }

  async createSdkToken(externalUserId: string): Promise<{ token: string; userId: string; expiresIn: number }> {
    this.assertExternalUserId(externalUserId);
    const body = JSON.stringify({ ttlInSecs: this.config.sdkTokenTtlSeconds, userId: externalUserId, levelName: this.config.levelName });
    const value = await this.call('POST', '/resources/accessTokens/sdk', body);
    if (!safe(value.token, 1024) || value.userId !== externalUserId) return fail('SUMSUB_RESPONSE_INVALID');
    return { token: value.token, userId: externalUserId, expiresIn: this.config.sdkTokenTtlSeconds };
  }

  private assertExternalUserId(value: string): void {
    if (!safe(value, 160) || !value.startsWith(this.externalUserIdPrefix)
      || !/^[A-Za-z0-9_-]+$/.test(value)) fail('SUMSUB_SUBJECT_MISMATCH', 403);
  }

  private async applicant(externalUserId: string): Promise<Record<string, unknown>> {
    this.assertExternalUserId(externalUserId);
    const value = await this.call('GET', `/resources/applicants/-;externalUserId=${encodeURIComponent(externalUserId)}/one`);
    if (!safe(value.id, 128) || !APPLICANT_ID.test(value.id) || value.externalUserId !== externalUserId
      || value.type !== 'individual' || !object(value.review) || value.review.levelName !== this.config.levelName
      || value.inspectionId !== undefined && (!safe(value.inspectionId, 128) || !APPLICANT_ID.test(value.inspectionId))) {
      return fail('SUMSUB_APPLICANT_MISMATCH', 403);
    }
    return value;
  }

  async evaluate(binding: SumsubSubjectBinding): Promise<SumsubEvidenceCandidate> {
    if (!binding || !WALLET.test(binding.walletAddress) || !safe(binding.flowId, 128)
      || !HASH.test(binding.processingPolicyFingerprint) || !HASH.test(binding.retentionPolicyFingerprint)
      || binding.externalUserId !== this.makeExternalUserId(binding.walletAddress, binding.flowId)) fail('SUMSUB_SUBJECT_MISMATCH', 403);
    const applicant = await this.applicant(binding.externalUserId);
    const applicantId = applicant.id as string;
    const status = await this.call('GET', `/resources/applicants/${encodeURIComponent(applicantId)}/status`);
    const reviewStatus = status.reviewStatus;
    if (!safe(reviewStatus, 64) || !REVIEW_STATUSES.has(reviewStatus)) return fail('SUMSUB_RESPONSE_INVALID');
    const rawResult = status.reviewResult;
    if (rawResult !== undefined && !object(rawResult)) return fail('SUMSUB_RESPONSE_INVALID');
    const result: Record<string, unknown> | undefined = rawResult === undefined ? undefined : rawResult as Record<string, unknown>;
    const reviewAnswer = result?.reviewAnswer === undefined ? null : result.reviewAnswer;
    if (reviewAnswer !== null && reviewAnswer !== 'GREEN' && reviewAnswer !== 'RED') return fail('SUMSUB_RESPONSE_INVALID');
    const rejectType = result?.reviewRejectType === undefined ? null : result.reviewRejectType;
    if (rejectType !== null && rejectType !== 'FINAL' && rejectType !== 'RETRY') return fail('SUMSUB_RESPONSE_INVALID');
    let decision: SumsubDecision = reviewStatus === 'init' ? 'not-started' : 'review';
    if (reviewStatus === 'completed' && reviewAnswer === 'GREEN') decision = 'approved';
    if (reviewStatus === 'completed' && reviewAnswer === 'RED') decision = rejectType === 'FINAL' ? 'rejected' : 'review';
    // The overall applicant answer does not authenticate which exact checks ran. `info.country`
    // is profile data, not approved-document provenance. Until step-result endpoints are mapped,
    // this candidate deliberately earns no Proofmark bits and no jurisdiction.
    const jurisdictionAlpha3 = null;
    const jurisdiction = null;
    const methods = 0;
    const observedAt = this.now();
    const base = {
      schema: 'proofmark-sumsub-evidence-v1' as const, provider: 'sumsub' as const, environment: this.environment,
      environmentEvidence: 'configured-credentials' as const,
      subject: binding.walletAddress.toLowerCase(), flowIdHash: keyedHash(this.config.evidenceHmacKey, 'flow', binding.flowId),
      externalUserIdHash: keyedHash(this.config.evidenceHmacKey, 'external-user', binding.externalUserId),
      applicantIdHash: keyedHash(this.config.evidenceHmacKey, 'applicant', applicantId),
      inspectionIdHash: typeof applicant.inspectionId === 'string' ? keyedHash(this.config.evidenceHmacKey, 'inspection', applicant.inspectionId) : null,
      levelName: this.levelName, methodMapping: 'pending-step-evidence' as const, methods,
      methodNames: [] as MethodName[], jurisdictionAlpha3, jurisdiction, decision, reviewStatus,
      reviewAnswer: reviewAnswer as 'GREEN' | 'RED' | null, reviewRejectType: rejectType as 'FINAL' | 'RETRY' | null,
      observedAt, providerReviewedAt: timestamp(status.reviewDate),
      webhookFence: null,
      processingPolicyFingerprint: binding.processingPolicyFingerprint.toLowerCase(),
      retentionPolicyFingerprint: binding.retentionPolicyFingerprint.toLowerCase(),
    };
    return withEvidenceHash(base);
  }

  verifyWebhook(rawBody: Uint8Array, headers: Headers): SumsubWebhook {
    if (!(rawBody instanceof Uint8Array) || rawBody.byteLength < 2 || rawBody.byteLength > 64 * 1024) return fail('SUMSUB_WEBHOOK_INVALID', 400);
    const algorithm = headers.get('x-payload-digest-alg');
    const digest = headers.get('x-payload-digest');
    if (algorithm !== 'HMAC_SHA256_HEX' || !digest || !/^[0-9a-f]{64}$/.test(digest)) return fail('SUMSUB_WEBHOOK_SIGNATURE_INVALID', 401);
    const expected = createHmac('sha256', this.config.webhookSecret).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(digest, 'hex'))) return fail('SUMSUB_WEBHOOK_SIGNATURE_INVALID', 401);
    let body: Record<string, unknown>;
    try { body = parseJson(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); }
    catch { return fail('SUMSUB_WEBHOOK_INVALID', 400); }
    if (!safe(body.applicantId, 128) || !APPLICANT_ID.test(body.applicantId) || !safe(body.externalUserId, 160)
      || !body.externalUserId.startsWith(this.externalUserIdPrefix) || !WEBHOOK_TYPES.has(body.type as string)
      || body.applicantType !== 'individual' || body.levelName !== this.levelName || typeof body.sandboxMode !== 'boolean'
      || body.sandboxMode !== (this.environment === 'sandbox')
      || body.testMode !== undefined && body.testMode !== true) return fail('SUMSUB_WEBHOOK_INVALID', 400);
    const createdAtMs = webhookTimestamp(body.createdAtMs);
    const now = this.now();
    if (!Number.isSafeInteger(createdAtMs) || !Number.isSafeInteger(now) || createdAtMs! > now + 30_000
      || now - createdAtMs! > this.config.maxWebhookAgeMs) return fail('SUMSUB_WEBHOOK_STALE', 409);
    if (body.reviewStatus !== undefined && (!safe(body.reviewStatus, 64) || !REVIEW_STATUSES.has(body.reviewStatus))) return fail('SUMSUB_WEBHOOK_INVALID', 400);
    if (body.reviewMode !== undefined && body.reviewMode !== 'ongoingAml' && body.reviewMode !== 'ongoingDocExpired') return fail('SUMSUB_WEBHOOK_INVALID', 400);
    const rawReviewResult = body.reviewResult;
    if (rawReviewResult !== undefined && !object(rawReviewResult)) return fail('SUMSUB_WEBHOOK_INVALID', 400);
    const reviewResult: Record<string, unknown> | undefined = rawReviewResult === undefined ? undefined : rawReviewResult as Record<string, unknown>;
    if (reviewResult?.reviewAnswer !== undefined && reviewResult.reviewAnswer !== 'GREEN' && reviewResult.reviewAnswer !== 'RED') return fail('SUMSUB_WEBHOOK_INVALID', 400);
    if (reviewResult?.reviewRejectType !== undefined && reviewResult.reviewRejectType !== 'FINAL' && reviewResult.reviewRejectType !== 'RETRY') return fail('SUMSUB_WEBHOOK_INVALID', 400);
    if ((body.type === 'applicantPending' && body.reviewStatus !== 'pending')
      || (body.type === 'applicantOnHold' && body.reviewStatus !== 'onHold')
      || (body.type === 'applicantReviewed' && (body.reviewStatus !== 'completed'
        || (reviewResult?.reviewAnswer !== 'GREEN' && reviewResult?.reviewAnswer !== 'RED')))) return fail('SUMSUB_WEBHOOK_INVALID', 400);
    return { applicantId: body.applicantId, externalUserId: body.externalUserId, type: body.type as SumsubWebhook['type'],
      createdAtMs: createdAtMs!, digest, sandboxMode: body.sandboxMode, testMode: body.testMode === true,
      ...(body.reviewStatus ? { reviewStatus: body.reviewStatus as string } : {}),
      ...(body.reviewMode ? { reviewMode: body.reviewMode as SumsubWebhook['reviewMode'] } : {}),
      ...(reviewResult?.reviewAnswer ? { reviewAnswer: reviewResult.reviewAnswer as 'GREEN' | 'RED' } : {}),
      ...(reviewResult?.reviewRejectType ? { reviewRejectType: reviewResult.reviewRejectType as 'FINAL' | 'RETRY' } : {}) };
  }

  matchesApplicant(candidate: SumsubEvidenceCandidate, applicantId: string): boolean {
    return APPLICANT_ID.test(applicantId)
      && candidate.applicantIdHash === keyedHash(this.config.evidenceHmacKey, 'applicant', applicantId);
  }
}
