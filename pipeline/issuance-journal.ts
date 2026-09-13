import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IssueOutcome } from './issue.js';
import type { VaultRecord } from './vault.js';
import type { ProcessingPolicyEvidenceV1 } from './privacy-processing-policy.js';
import type { RetentionPolicyBindingV1 } from './retention-policy.js';

export type IssuancePhase = 'prepared' | 'submitted' | 'source-confirmed' | 'materialized' | 'failed';
export interface SignedIssuance {
  hash: string; raw: string; nonce: number; chainId: number; source: string; issuer: string;
  /** Decimal gas ceiling bound to the signed transaction; string keeps journal JSON exact. */
  gasLimit?: string;
}
export interface SourceConfirmation {
  blockNumber: number; blockHash: string; transactionIndex: number; confirmedAt: number;
  /** Decimal receipt usage, present for newly observed receipts and safe for encrypted JSON. */
  gasUsed?: string;
}
export interface IssuanceEntry {
  version: 1;
  requestId: string;
  wallet: string;
  fingerprint: string;
  consentVersion: string;
  /** Absent only on records created before the v1 processing-policy gate. */
  processingPolicy?: ProcessingPolicyEvidenceV1;
  /** Consent-bound retention policy; absent only on pre-T-33 entries, which cannot be resumed. */
  retentionPolicy?: RetentionPolicyBindingV1;
  createdAt: number;
  /** A never-signed preparation cannot be sent after this deadline without a new screening flow. */
  prepareUntil: number;
  phase: IssuancePhase;
  target: {
    chainId: number; source: string; issuer: string; hubChainId: number; asc: string;
    /** Absent/direct preserves the legacy EOA path. Rotating targets pin the public operator epoch. */
    issuerMode?: 'direct' | 'rotating'; operatingKey?: string; issuerKeyEpoch?: number;
  };
  outcome: IssueOutcome;
  assurance: number;
  /** Full evidence record is encrypted in transit/storage; it is copied to the retention vault before signing. */
  evidenceRecord?: VaultRecord;
  evidenceStored: boolean;
  transaction?: SignedIssuance;
  revertedTransactions: { hash: string; nonce: number; at: number }[];
  sourceConfirmation?: SourceConfirmation;
  broadcastAcceptedAt?: number;
  materializedAt?: number;
  lastError?: string;
}
export interface JournalSnapshot { revision: number; entry: IssuanceEntry }
export class IssuanceJournalError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'IssuanceJournalError'; }
}
export interface IssuanceJournal {
  create(entry: IssuanceEntry): Promise<JournalSnapshot>;
  get(id: string): Promise<JournalSnapshot | null>;
  acquire(id: string, owner: string): Promise<JournalSnapshot>;
  save(snapshot: JournalSnapshot, owner: string): Promise<JournalSnapshot>;
  release(id: string, owner: string): Promise<void>;
  pending(): Promise<string[]>;
}

/** All multi-key transitions execute in one Redis hash slot. The signer gate has NO lease expiry:
 * an unknown transaction outcome must never let a different request take the same pending nonce.
 * Request leases may expire; a stale owner cannot save and therefore cannot broadcast a new tx.
 */
export const ISSUANCE_JOURNAL_LUA = `
local op = ARGV[1]
local id = ARGV[2]
local owner = ARGV[3]
local tm = redis.call('TIME')
local now = tonumber(tm[1])*1000 + math.floor(tonumber(tm[2])/1000)
-- Capability check before any mutation, including create/acquire. Older Redis fails closed.
local existingExpiry = redis.call('PEXPIRETIME', KEYS[1])
if (op == 'create' or op == 'save') and ARGV[8] == '1'
  and not redis.acl_check_cmd('PEXPIREAT', KEYS[1], tostring(now+86400000)) then
  return {'JOURNAL_UNAVAILABLE'}
end
local savedDeadline = redis.call('HGET', KEYS[1], 'terminalExpiresAt')
local savedUntil = savedDeadline and tonumber(savedDeadline) or nil
if savedDeadline then
  if not savedUntil or savedUntil <= 0 or savedUntil > 9007199254740991 or savedUntil ~= math.floor(savedUntil) then return {'RETENTION_STATE_INVALID'} end
  if savedUntil <= now then return {'RETENTION_DEADLINE_PASSED'} end
end
local function snapshot()
  return {'ok', tostring(redis.call('HGET', KEYS[1], 'revision')), redis.call('HGET', KEYS[1], 'payload')}
end
-- Redis 7 PEXPIRETIME preserves the exact existing deadline when adopting legacy terminal keys.
-- A completion episode has one deadline: saving diagnostics must not restart its 24h clock.
local function terminalDeadline()
  local deadline = savedUntil
  local current = existingExpiry
  if current > 0 and (not deadline or current < deadline) then deadline = current end
  return deadline or now+86400000
end
local function retain(terminalUntil)
  if ARGV[8] == '1' then
    redis.call('HSET', KEYS[1], 'terminalExpiresAt', terminalUntil)
    redis.call('PEXPIREAT', KEYS[1], terminalUntil)
    redis.call('ZREM', KEYS[3], id)
  else
    -- An explicit retry/reconciliation episode must remain durable while its nonce is unresolved.
    redis.call('HDEL', KEYS[1], 'terminalExpiresAt')
    redis.call('PERSIST', KEYS[1])
    redis.call('ZADD', KEYS[3], 'NX', now, id)
  end
end
if op == 'pending' then
  local result = redis.call('SMEMBERS', KEYS[4])
  local seen = {}
  for _,value in ipairs(result) do seen[value] = true end
  for _,value in ipairs(redis.call('ZRANGE', KEYS[3], 0, 999)) do
    if not seen[value] then table.insert(result, value) end
  end
  return result
end
if op == 'create' then
  if redis.call('EXISTS', KEYS[1]) == 1 then return snapshot() end
  if ARGV[8] == '1' and ARGV[6] == '1' then return {'RETENTION_STATE_INVALID'} end
  redis.call('HSET', KEYS[1], 'revision', 1, 'payload', ARGV[5], 'signer', ARGV[7], 'needsSigner', ARGV[6])
  retain(now+86400000)
  return snapshot()
end
if redis.call('EXISTS', KEYS[1]) == 0 then return {'NOT_FOUND'} end
if op == 'get' then return snapshot() end
if op == 'release' then
  if redis.call('HGET', KEYS[1], 'owner') == owner then redis.call('HDEL', KEYS[1], 'owner', 'leaseUntil') end
  return {'released'}
end
if redis.call('HGET', KEYS[1], 'signer') ~= ARGV[7] then return {'TARGET_CONFLICT'} end
if op == 'acquire' then
  if tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0') > now then return {'REQUEST_BUSY'} end
  if redis.call('HGET', KEYS[1], 'needsSigner') == '1' then
    local current = redis.call('GET', KEYS[2])
    if current and current ~= id then return {'SIGNER_BUSY'} end
    redis.call('SET', KEYS[2], id)
    redis.call('SADD', KEYS[4], id)
  end
  redis.call('HSET', KEYS[1], 'owner', owner, 'leaseUntil', now+30000)
  return snapshot()
end
if op == 'save' then
  if redis.call('HGET', KEYS[1], 'owner') ~= owner or tonumber(redis.call('HGET', KEYS[1], 'leaseUntil') or '0') <= now then return {'LEASE_LOST'} end
  if redis.call('HGET', KEYS[1], 'revision') ~= ARGV[4] then return {'REVISION_CONFLICT'} end
  -- Validate before touching the signer gate: Lua errors do not roll earlier Redis writes back.
  local terminalUntil = terminalDeadline()
  if ARGV[8] == '1' and ARGV[6] == '1' then return {'RETENTION_STATE_INVALID'} end
  if ARGV[6] == '1' then
    local current = redis.call('GET', KEYS[2])
    if current and current ~= id then return {'SIGNER_BUSY'} end
    redis.call('SET', KEYS[2], id)
    redis.call('SADD', KEYS[4], id)
  else
    if redis.call('GET', KEYS[2]) == id then redis.call('DEL', KEYS[2]) end
    redis.call('SREM', KEYS[4], id)
  end
  redis.call('HSET', KEYS[1], 'payload', ARGV[5], 'needsSigner', ARGV[6], 'leaseUntil', now+30000)
  redis.call('HINCRBY', KEYS[1], 'revision', 1)
  retain(terminalUntil)
  return snapshot()
end
return {'INVALID_OPERATION'}
`;

const needsSigner = (entry: IssuanceEntry) => entry.outcome.status === 'ISSUED' && (entry.phase === 'prepared' || entry.phase === 'submitted');
const terminal = (entry: IssuanceEntry) => entry.phase === 'failed' || entry.phase === 'materialized';
const requestId = (id: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new IssuanceJournalError('INVALID_REQUEST_ID');
  return id.toLowerCase();
};
const signerKey = (entry: IssuanceEntry) => createHash('sha256').update(`${entry.target.chainId}|${entry.target.issuer.toLowerCase()}`).digest('hex');

export class RedisIssuanceJournal implements IssuanceJournal {
  private readonly key: Buffer;
  private readonly endpoint: string;
  constructor(url: string, private readonly token: string, secret: string, private readonly request: typeof fetch = fetch, private readonly namespace = 'proofmark') {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token || secret.length < 32 || !/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new IssuanceJournalError('INVALID_JOURNAL_CONFIG');
    this.endpoint = endpoint.toString();
    this.key = createHash('sha256').update(`${secret}|proofmark-issuance-journal-v1`).digest();
  }
  private seal(entry: IssuanceEntry): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(requestId(entry.requestId)));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entry)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }
  private open(id: string, ciphertext: string): IssuanceEntry {
    try {
      const bytes = Buffer.from(ciphertext, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(requestId(id))); decipher.setAuthTag(bytes.subarray(12, 28));
      const entry = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')) as IssuanceEntry;
      if (entry.version !== 1 || requestId(entry.requestId) !== requestId(id)) throw new Error('bad journal version or identity');
      return entry;
    } catch { throw new IssuanceJournalError('JOURNAL_AUTHENTICATION_FAILED'); }
  }
  private async run(op: string, id: string, owner = '', snapshot?: JournalSnapshot): Promise<string[]> {
    const prefix = `{${this.namespace}:issuance}:`;
    const signer = snapshot ? signerKey(snapshot.entry) : '';
    const keys = [`${prefix}request:${requestId(id)}`, `${prefix}signer:${signer}`, `${prefix}pending`, `${prefix}active-signers`];
    const payload = snapshot ? this.seal(snapshot.entry) : '';
    if (payload.length > 500_000) throw new IssuanceJournalError('JOURNAL_ENTRY_TOO_LARGE');
    try {
      const response = await this.request(this.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', ISSUANCE_JOURNAL_LUA, keys.length, ...keys, op, requestId(id), owner,
          snapshot?.revision ?? 0, payload, snapshot && needsSigner(snapshot.entry) ? '1' : '0', signer,
          snapshot && terminal(snapshot.entry) ? '1' : '0']),
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('journal unavailable');
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (body.error || !Array.isArray(body.result) || !body.result.every(v => typeof v === 'string')) throw new Error('invalid journal result');
      return body.result;
    } catch { throw new IssuanceJournalError('JOURNAL_UNAVAILABLE'); }
  }
  private snapshot(id: string, result: string[]): JournalSnapshot {
    if (result[0] !== 'ok') throw new IssuanceJournalError(result[0] || 'JOURNAL_UNAVAILABLE');
    const revision = Number(result[1]);
    if (!Number.isSafeInteger(revision) || revision < 1) throw new IssuanceJournalError('BAD_JOURNAL_REVISION');
    return { revision, entry: this.open(id, result[2]) };
  }
  async create(entry: IssuanceEntry): Promise<JournalSnapshot> {
    return this.snapshot(entry.requestId, await this.run('create', entry.requestId, '', { revision: 0, entry }));
  }
  async get(id: string): Promise<JournalSnapshot | null> {
    const result = await this.run('get', id);
    return result[0] === 'NOT_FOUND' ? null : this.snapshot(id, result);
  }
  async acquire(id: string, owner: string): Promise<JournalSnapshot> {
    const snapshot = await this.get(id);
    if (!snapshot) throw new IssuanceJournalError('NOT_FOUND');
    return this.snapshot(id, await this.run('acquire', id, owner, snapshot));
  }
  async save(snapshot: JournalSnapshot, owner: string): Promise<JournalSnapshot> {
    return this.snapshot(snapshot.entry.requestId, await this.run('save', snapshot.entry.requestId, owner, snapshot));
  }
  async release(id: string, owner: string): Promise<void> { await this.run('release', id, owner); }
  async pending(): Promise<string[]> { return this.run('pending', '0x' + '00'.repeat(32)); }
}
