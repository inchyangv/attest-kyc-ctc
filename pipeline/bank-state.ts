/** Bank state contains only opaque keyed identifiers and encrypted response tokens, never PII. */
export const BANK_LIMITS = { attempts: 5, flowStarts: 3, accountStarts: 3, walletStarts: 5, globalStarts: 1000, lifetimeMs: 600_000, budgetMs: 86_400_000 } as const;
export interface BankReservation {
  requestKey: string; flowKey: string; accountKey: string; walletKey: string;
  fingerprint: string; challengeId: string;
}
export type ReserveResult = { status: 'reserved'; expiresAt: number } | { status: 'cached'; response: string };
export type VerifyResult = { status: 'verified' } | { status: 'mismatch'; remaining: number };
export class BankStateError extends Error {
  constructor(readonly code: string, message = 'Bank challenge is unavailable; do not retry a deposit with a new request ID unless deliberately restarting.') {
    super(message); this.name = 'BankStateError';
  }
}
export interface BankStateStore {
  readonly mode: 'redis' | 'demo-memory';
  reserve(input: BankReservation): Promise<ReserveResult>;
  activate(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>, encryptedResponse: string): Promise<void>;
  verify(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>, matches: boolean): Promise<VerifyResult>;
}

// All keys use one hash tag. The operation must execute on one authoritative Redis primary, not
// application GET/SET pairs or a read-replica cache. Redis TIME owns expiry and quota windows.
export const BANK_STATE_LUA = `
local tm = redis.call('TIME')
local now = tonumber(tm[1]) * 1000 + math.floor(tonumber(tm[2]) / 1000)
local op = ARGV[1]
local id = ARGV[2]
local life = tonumber(ARGV[5])
local budget = tonumber(ARGV[6])
if op == 'reserve' then
  if redis.call('EXISTS', KEYS[1]) == 1 then
    if redis.call('HGET', KEYS[1], 'fingerprint') ~= ARGV[3] then return {'CONFLICT'} end
    local state = redis.call('HGET', KEYS[1], 'state')
    if state == 'ready' and redis.call('HGET', KEYS[2], 'current') == redis.call('HGET', KEYS[1], 'id') and tonumber(redis.call('HGET', KEYS[1], 'expires')) > now then
      return {'cached', redis.call('HGET', KEYS[1], 'response')}
    end
    return {state == 'pending' and 'START_PENDING' or 'CHALLENGE_UNAVAILABLE'}
  end
  local limits = {tonumber(ARGV[7]), tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10])}
  for i=2,5 do
    if tonumber(redis.call('HGET', KEYS[i], 'count') or '0') >= limits[i-1] then return {'START_BUDGET_EXCEEDED'} end
  end
  for i=2,5 do
    local count = redis.call('HINCRBY', KEYS[i], 'count', 1)
    if count == 1 then redis.call('PEXPIRE', KEYS[i], budget) end
  end
  redis.call('HSET', KEYS[2], 'current', id)
  redis.call('HSET', KEYS[1], 'state', 'pending', 'id', id, 'fingerprint', ARGV[3], 'expires', now+life, 'attempts', 0)
  redis.call('PEXPIRE', KEYS[1], budget)
  return {'reserved', tostring(now+life)}
end
if redis.call('HGET', KEYS[1], 'id') ~= id or redis.call('HGET', KEYS[2], 'current') ~= id then return {'CHALLENGE_UNAVAILABLE'} end
if tonumber(redis.call('HGET', KEYS[1], 'expires') or '0') <= now then return {'CHALLENGE_EXPIRED'} end
local state = redis.call('HGET', KEYS[1], 'state')
if op == 'activate' then
  if state ~= 'pending' then return {'CHALLENGE_UNAVAILABLE'} end
  redis.call('HSET', KEYS[1], 'state', 'ready', 'response', ARGV[4])
  return {'activated'}
end
if op ~= 'verify' then return {'INVALID_OPERATION'} end
if state == 'locked' then return {'TOO_MANY_ATTEMPTS'} end
if state ~= 'ready' then return {'CHALLENGE_UNAVAILABLE'} end
if ARGV[4] == '1' then
  redis.call('HSET', KEYS[1], 'state', 'consumed')
  redis.call('HDEL', KEYS[1], 'response')
  return {'verified'}
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts >= tonumber(ARGV[11]) then
  redis.call('HSET', KEYS[1], 'state', 'locked')
  redis.call('HDEL', KEYS[1], 'response')
  return {'TOO_MANY_ATTEMPTS'}
end
return {'mismatch', tostring(tonumber(ARGV[11])-attempts)}
`;

const identifier = (value: string) => {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(value)) throw new BankStateError('INVALID_STATE_ID');
  return value;
};

export class RedisBankStateStore implements BankStateStore {
  readonly mode = 'redis' as const;
  private readonly endpoint: string;
  constructor(url: string, private readonly token: string, private readonly request: typeof fetch = fetch, private readonly namespace = 'proofmark') {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new BankStateError('INVALID_STATE_CONFIG');
    if (!token || !/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)) throw new BankStateError('INVALID_STATE_CONFIG');
    this.endpoint = endpoint.toString();
  }
  private async run(op: string, input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'> & Partial<BankReservation>, value = ''): Promise<string[]> {
    const prefix = `{${this.namespace}:bank}:`;
    const key = (kind: string, id: string) => `${prefix}${kind}:${identifier(id)}`;
    const keys = [key('request', input.requestKey), key('flow', input.flowKey),
      key('account', input.accountKey ?? input.flowKey), key('wallet', input.walletKey ?? input.flowKey), `${prefix}global`];
    identifier(input.challengeId);
    if (value.length > 32_768) throw new BankStateError('STATE_PAYLOAD_TOO_LARGE');
    try {
      const response = await this.request(this.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(['EVAL', BANK_STATE_LUA, keys.length, ...keys, op, input.challengeId, input.fingerprint ?? '', value,
          BANK_LIMITS.lifetimeMs, BANK_LIMITS.budgetMs, BANK_LIMITS.flowStarts, BANK_LIMITS.accountStarts, BANK_LIMITS.walletStarts, BANK_LIMITS.globalStarts, BANK_LIMITS.attempts]),
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error('store unavailable');
      const data = await response.json() as { result?: unknown; error?: unknown };
      if (data.error || !Array.isArray(data.result) || !data.result.every(v => typeof v === 'string')) throw new Error('invalid store result');
      return data.result;
    } catch { throw new BankStateError('STATE_UNAVAILABLE', 'Shared bank verification state is unavailable. No local fallback is allowed.'); }
  }
  async reserve(input: BankReservation): Promise<ReserveResult> {
    const [status, value] = await this.run('reserve', input);
    if (status === 'reserved' && Number.isSafeInteger(Number(value))) return { status, expiresAt: Number(value) };
    if (status === 'cached' && value) return { status, response: value };
    throw new BankStateError(status || 'STATE_UNAVAILABLE');
  }
  async activate(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>, response: string): Promise<void> {
    const [status] = await this.run('activate', input, response);
    if (status !== 'activated') throw new BankStateError(status || 'STATE_UNAVAILABLE');
  }
  async verify(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>, matches: boolean): Promise<VerifyResult> {
    const [status, value] = await this.run('verify', input, matches ? '1' : '0');
    if (status === 'verified') return { status };
    if (status === 'mismatch' && Number(value) > 0 && Number(value) < BANK_LIMITS.attempts) return { status, remaining: Number(value) };
    throw new BankStateError(status || 'STATE_UNAVAILABLE');
  }
}

/** Explicit sandbox-only adapter. Restart/another isolated instance loses a challenge and rejects
 * it; it never reconstructs attempt counts from a client token. Real bank rails require Redis. */
export class DemoBankStateStore implements BankStateStore {
  readonly mode = 'demo-memory' as const;
  private records = new Map<string, { input: BankReservation; state: string; expiresAt: number; deleteAt: number; attempts: number; response?: string }>();
  private budgets = new Map<string, { count: number; expiresAt: number; current?: string }>();
  constructor(private readonly now = Date.now) {}
  async reserve(input: BankReservation): Promise<ReserveResult> {
    const now = this.now();
    for (const [key, value] of this.records) if (value.deleteAt <= now) this.records.delete(key);
    for (const [key, value] of this.budgets) if (value.expiresAt <= now) this.budgets.delete(key);
    const old = this.records.get(input.requestKey);
    if (old) {
      if (old.input.fingerprint !== input.fingerprint) throw new BankStateError('CONFLICT');
      if (old.state === 'ready' && old.expiresAt > now && this.budgets.get(`f:${input.flowKey}`)?.current === old.input.challengeId) return { status: 'cached', response: old.response! };
      throw new BankStateError(old.state === 'pending' ? 'START_PENDING' : 'CHALLENGE_UNAVAILABLE');
    }
    const keys = [`f:${input.flowKey}`, `a:${input.accountKey}`, `w:${input.walletKey}`, 'global'];
    const limits = [BANK_LIMITS.flowStarts, BANK_LIMITS.accountStarts, BANK_LIMITS.walletStarts, BANK_LIMITS.globalStarts];
    if (keys.some((key, i) => (this.budgets.get(key)?.count ?? 0) >= limits[i])) throw new BankStateError('START_BUDGET_EXCEEDED');
    for (const key of keys) {
      const prior = this.budgets.get(key) ?? { count: 0, expiresAt: now + BANK_LIMITS.budgetMs };
      prior.count++; this.budgets.set(key, prior);
    }
    this.budgets.get(keys[0])!.current = input.challengeId;
    this.records.set(input.requestKey, { input: structuredClone(input), state: 'pending', attempts: 0, expiresAt: now + BANK_LIMITS.lifetimeMs, deleteAt: now + BANK_LIMITS.budgetMs });
    return { status: 'reserved', expiresAt: now + BANK_LIMITS.lifetimeMs };
  }
  private current(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>) {
    const record = this.records.get(input.requestKey);
    if (!record || record.input.challengeId !== input.challengeId || this.budgets.get(`f:${input.flowKey}`)?.current !== input.challengeId) throw new BankStateError('CHALLENGE_UNAVAILABLE');
    if (record.expiresAt <= this.now()) throw new BankStateError('CHALLENGE_EXPIRED');
    return record;
  }
  async activate(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>, response: string): Promise<void> {
    const record = this.current(input);
    if (record.state !== 'pending') throw new BankStateError('CHALLENGE_UNAVAILABLE');
    record.state = 'ready'; record.response = response;
  }
  async verify(input: Pick<BankReservation, 'requestKey' | 'flowKey' | 'challengeId'>, matches: boolean): Promise<VerifyResult> {
    const record = this.current(input);
    if (record.state === 'locked') throw new BankStateError('TOO_MANY_ATTEMPTS');
    if (record.state !== 'ready') throw new BankStateError('CHALLENGE_UNAVAILABLE');
    if (matches) { record.state = 'consumed'; delete record.response; return { status: 'verified' }; }
    record.attempts++;
    if (record.attempts >= BANK_LIMITS.attempts) { record.state = 'locked'; delete record.response; throw new BankStateError('TOO_MANY_ATTEMPTS'); }
    return { status: 'mismatch', remaining: BANK_LIMITS.attempts - record.attempts };
  }
}
