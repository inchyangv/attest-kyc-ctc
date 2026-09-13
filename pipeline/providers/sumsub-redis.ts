import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { retainSumsubWebhookFence, type SumsubEvidenceCandidate } from './sumsub.js';
import type { SumsubSessionRecord, SumsubStateStore, SumsubWebhookClaim } from './sumsub-state.js';

export class SumsubStateError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'SumsubStateError'; }
}

const LUA = `
local op = ARGV[1]
if op == 'create' then
  local old = redis.call('GET', KEYS[1])
  if old then return {'existing', old} end
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3], 'NX')
  redis.call('HSET', KEYS[3], 'revision', '1')
  redis.call('EXPIRE', KEYS[3], ARGV[3])
  return {'fresh'}
end
if op == 'get' then
  local old = redis.call('GET', KEYS[1])
  if not old then return {'missing'} end
  return {'ok', old}
end
if op == 'save' then
  if redis.call('EXISTS', KEYS[1]) == 0 then return {'missing'} end
  local revision = tonumber(redis.call('HGET', KEYS[3], 'revision') or '0')
  if revision ~= tonumber(ARGV[6]) then return {'revision_conflict'} end
  local latestEvent = tonumber(redis.call('HGET', KEYS[3], 'eventAt') or '0')
  local reviewedAt = tonumber(ARGV[4] or '0')
  local carriedFence = tonumber(ARGV[5] or '0')
  if latestEvent > reviewedAt and carriedFence < latestEvent then return {'fenced'} end
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  redis.call('HINCRBY', KEYS[3], 'revision', 1)
  return {'ok', tostring(revision+1)}
end
if op == 'webhook' then
  if redis.call('EXISTS', KEYS[1]) == 0 then return {'conflict'} end
  if redis.call('EXISTS', KEYS[2]) == 1 then return {'duplicate'} end
  local revision = tonumber(redis.call('HGET', KEYS[3], 'revision') or '0')
  if revision ~= tonumber(ARGV[7]) then return {'revision_conflict'} end
  local applicant = redis.call('HGET', KEYS[3], 'applicant')
  local eventAt = tonumber(redis.call('HGET', KEYS[3], 'eventAt') or '0')
  if applicant and applicant ~= ARGV[5] then return {'conflict'} end
  if eventAt >= tonumber(ARGV[4]) then return {'stale'} end
  redis.call('SET', KEYS[2], '1', 'EX', ARGV[3], 'NX')
  redis.call('HSET', KEYS[3], 'applicant', ARGV[5], 'eventAt', ARGV[4])
  redis.call('EXPIRE', KEYS[3], ARGV[3])
  if ARGV[6] and ARGV[6] ~= '' then redis.call('SET', KEYS[1], ARGV[6], 'KEEPTTL') end
  redis.call('HINCRBY', KEYS[3], 'revision', 1)
  return {'fresh', tostring(revision+1)}
end
return {'invalid'}
`;

export class RedisSumsubStateStore implements SumsubStateStore {
  private readonly endpoint: string;
  private readonly key: Buffer;
  constructor(url: string, private readonly token: string, secret: string, private readonly ttlSeconds: number,
    private readonly request: typeof fetch = fetch, private readonly namespace = 'proofmark') {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !token || secret.length < 32 || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 600 || ttlSeconds > 31_536_000
      || !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new SumsubStateError('SUMSUB_STATE_CONFIG_INVALID');
    this.endpoint = endpoint.toString();
    this.key = createHash('sha256').update(`${secret}|proofmark-sumsub-state-v1`).digest();
  }
  private opaque(value: string): string { return createHash('sha256').update(`proofmark-sumsub-key-v1\0${value}`).digest('hex'); }
  private keys(externalUserId: string, digest = ''): [string, string, string] {
    const user = this.opaque(externalUserId); const prefix = `{${this.namespace}:sumsub:${user}}:`;
    return [`${prefix}state`, `${prefix}event:${this.opaque(digest)}`, `${prefix}latest`];
  }
  private seal(record: SumsubSessionRecord): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(record.externalUserId));
    const ct = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
  }
  private open(externalUserId: string, value: string): SumsubSessionRecord {
    try {
      const bytes = Buffer.from(value, 'base64url'); if (bytes.length < 29) throw new Error('short');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(externalUserId)); decipher.setAuthTag(bytes.subarray(12, 28));
      const record = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as SumsubSessionRecord;
      if (record.version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1
        || record.externalUserId !== externalUserId) throw new Error('identity');
      return record;
    } catch { throw new SumsubStateError('SUMSUB_STATE_AUTHENTICATION_FAILED'); }
  }
  private async run(keys: string[], args: string[]): Promise<string[]> {
    try {
      const response = await this.request(this.endpoint, { method: 'POST', redirect: 'error', cache: 'no-store',
        signal: AbortSignal.timeout(5_000), headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', LUA, keys.length, ...keys, ...args]) });
      if (!response.ok) throw new Error('http');
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (body.error || !Array.isArray(body.result) || !body.result.every(value => typeof value === 'string')) throw new Error('shape');
      return body.result;
    } catch { throw new SumsubStateError('SUMSUB_STATE_UNAVAILABLE'); }
  }
  async create(record: SumsubSessionRecord): Promise<'fresh' | 'existing' | 'conflict'> {
    const result = await this.run(this.keys(record.externalUserId), ['create', this.seal(record), String(this.ttlSeconds)]);
    if (result[0] === 'fresh') return 'fresh';
    if (result[0] !== 'existing' || !result[1]) throw new SumsubStateError('SUMSUB_STATE_UNAVAILABLE');
    const prior = this.open(record.externalUserId, result[1]);
    return prior.walletAddress.toLowerCase() === record.walletAddress.toLowerCase() && prior.flowId === record.flowId
      && prior.environment === record.environment && prior.levelName === record.levelName
      && prior.identityPolicyId === record.identityPolicyId
      && prior.processingPolicyFingerprint === record.processingPolicyFingerprint
      && prior.retentionPolicyFingerprint === record.retentionPolicyFingerprint ? 'existing' : 'conflict';
  }
  async get(externalUserId: string): Promise<SumsubSessionRecord | null> {
    const result = await this.run(this.keys(externalUserId), ['get']);
    if (result[0] === 'missing') return null;
    if (result[0] !== 'ok' || !result[1]) throw new SumsubStateError('SUMSUB_STATE_UNAVAILABLE');
    return this.open(externalUserId, result[1]);
  }
  async saveObservation(externalUserId: string, evidence: SumsubEvidenceCandidate, expectedRevision: number): Promise<SumsubEvidenceCandidate> {
    const record = await this.get(externalUserId); if (!record) throw new SumsubStateError('SUMSUB_SESSION_NOT_FOUND');
    if (record.revision !== expectedRevision) throw new SumsubStateError('SUMSUB_REVISION_CONFLICT');
    record.latest = evidence;
    record.revision = expectedRevision + 1;
    const result = await this.run(this.keys(externalUserId), ['save', this.seal(record), String(this.ttlSeconds),
      String(evidence.providerReviewedAt ?? 0), String(evidence.webhookFence?.eventAt ?? 0), String(expectedRevision)]);
    if (result[0] === 'fenced') throw new SumsubStateError('SUMSUB_STATUS_FENCED');
    if (result[0] === 'revision_conflict') throw new SumsubStateError('SUMSUB_REVISION_CONFLICT');
    if (result[0] !== 'ok') throw new SumsubStateError(result[0] === 'missing' ? 'SUMSUB_SESSION_NOT_FOUND' : 'SUMSUB_STATE_UNAVAILABLE');
    return evidence;
  }
  async applyWebhook(externalUserId: string, digest: string, eventAt: number, applicantId: string,
    evidence: SumsubEvidenceCandidate): Promise<SumsubWebhookClaim> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = await this.get(externalUserId); if (!record) return 'conflict';
      record.latest = retainSumsubWebhookFence(evidence, record.latest);
      const expectedRevision = record.revision; record.revision++;
      const result = await this.run(this.keys(externalUserId, digest),
        ['webhook', '', String(this.ttlSeconds), String(eventAt), applicantId, this.seal(record), String(expectedRevision)]);
      if (result[0] === 'revision_conflict') continue;
      if (!['fresh', 'duplicate', 'stale', 'conflict'].includes(result[0])) throw new SumsubStateError('SUMSUB_STATE_UNAVAILABLE');
      return result[0] as SumsubWebhookClaim;
    }
    throw new SumsubStateError('SUMSUB_REVISION_CONFLICT');
  }
}
