import { createHmac } from 'node:crypto';
import { getAddress, isAddress } from 'ethers';

export type IssuanceBudgetStatus = { reservedGas: bigint; transactionCount: number };
export type IssuanceGasReservation = { requestId: string; issuer: string; gasLimit: bigint };
export type IssuanceGasReconciliation = { requestId: string; issuer: string; gasUsed: bigint };
export interface IssuanceBudget {
  reserve(input: IssuanceGasReservation): Promise<IssuanceBudgetStatus>;
  reconcile(input: IssuanceGasReconciliation): Promise<void>;
}

export class IssuanceBudgetError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'IssuanceBudgetError'; }
}

export interface RedisIssuanceBudgetConfig {
  url: string;
  token: string;
  secret: string;
  namespace?: string;
  dailyGasLimit: bigint;
  dailyTransactionLimit: number;
}

/** One UTC-day ledger per issuer. Reservation records are durable while an outcome is unknown;
 * confirmed records receive a short TTL. Redis TIME, not an app instance clock, chooses the day. */
export const ISSUANCE_BUDGET_LUA = `
local op = ARGV[1]
local issuer = ARGV[2]
local request = ARGV[3]
local amount = tonumber(ARGV[4])
local maxGas = tonumber(ARGV[5])
local maxTx = tonumber(ARGV[6])
local tm = redis.call('TIME')
local now = tonumber(tm[1])*1000 + math.floor(tonumber(tm[2])/1000)
local day = math.floor(now/86400000)
local savedDay = tonumber(redis.call('HGET', KEYS[1], 'day') or '-1')
local totalGas = tonumber(redis.call('HGET', KEYS[1], 'gas') or '0')
local totalTx = tonumber(redis.call('HGET', KEYS[1], 'tx') or '0')
if savedDay ~= day then totalGas = 0; totalTx = 0 end
if op == 'status' then return {'ok', tostring(totalGas), tostring(totalTx)} end
if not amount or amount < 0 or amount ~= math.floor(amount) then return {'INVALID_BUDGET_INPUT'} end
if op == 'reserve' then
  if redis.call('EXISTS', KEYS[2]) == 1 then
    if redis.call('HGET', KEYS[2], 'issuer') ~= issuer or tonumber(redis.call('HGET', KEYS[2], 'reserved')) ~= amount then
      return {'BUDGET_REQUEST_CONFLICT'}
    end
    return {'ok', redis.call('HGET', KEYS[2], 'ledgerGas'), redis.call('HGET', KEYS[2], 'ledgerTx')}
  end
  if amount <= 0 or amount > maxGas then return {'DAILY_GAS_BUDGET_EXCEEDED'} end
  if totalGas + amount > maxGas then return {'DAILY_GAS_BUDGET_EXCEEDED'} end
  if totalTx + 1 > maxTx then return {'DAILY_TRANSACTION_BUDGET_EXCEEDED'} end
  totalGas = totalGas + amount; totalTx = totalTx + 1
  redis.call('HSET', KEYS[1], 'day', day, 'gas', totalGas, 'tx', totalTx)
  redis.call('PEXPIREAT', KEYS[1], (day+3)*86400000)
  redis.call('HSET', KEYS[2], 'issuer', issuer, 'request', request, 'day', day, 'reserved', amount,
    'reconciled', 0, 'ledgerGas', totalGas, 'ledgerTx', totalTx)
  redis.call('PERSIST', KEYS[2])
  return {'ok', tostring(totalGas), tostring(totalTx)}
end
if op == 'reconcile' then
  if redis.call('EXISTS', KEYS[2]) == 0 then return {'BUDGET_RESERVATION_MISSING'} end
  if redis.call('HGET', KEYS[2], 'issuer') ~= issuer then return {'BUDGET_REQUEST_CONFLICT'} end
  local reserved = tonumber(redis.call('HGET', KEYS[2], 'reserved'))
  if amount > reserved then return {'BUDGET_ACTUAL_EXCEEDS_RESERVATION'} end
  local reconciled = redis.call('HGET', KEYS[2], 'reconciled') == '1'
  if reconciled then
    if tonumber(redis.call('HGET', KEYS[2], 'used')) ~= amount then return {'BUDGET_REQUEST_CONFLICT'} end
    return {'ok'}
  end
  local reservationDay = tonumber(redis.call('HGET', KEYS[2], 'day'))
  if savedDay == day and reservationDay == day then
    totalGas = totalGas - reserved + amount
    if totalGas < 0 then return {'BUDGET_STATE_INVALID'} end
    redis.call('HSET', KEYS[1], 'gas', totalGas)
  end
  redis.call('HSET', KEYS[2], 'reconciled', 1, 'used', amount)
  redis.call('PEXPIRE', KEYS[2], 172800000)
  return {'ok'}
end
return {'INVALID_OPERATION'}
`;

const REQUEST = /^0x[0-9a-fA-F]{64}$/;
const safeInteger = (value: bigint, name: string) => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new IssuanceBudgetError(`INVALID_${name}`);
  return Number(value);
};

export class RedisIssuanceBudget implements IssuanceBudget {
  private readonly endpoint: string;
  private readonly namespace: string;
  private readonly key: Buffer;
  private readonly token: string;
  private readonly gasLimit: number;
  private readonly transactionLimit: number;
  constructor(config: RedisIssuanceBudgetConfig, private readonly request: typeof fetch = fetch) {
    let endpoint: URL;
    try { endpoint = new URL(config.url); } catch { throw new IssuanceBudgetError('INVALID_BUDGET_CONFIG'); }
    const namespace = config.namespace ?? 'proofmark';
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !config.token || config.secret.length < 32 || !/^[a-zA-Z0-9_-]{1,64}$/.test(namespace)
      || !Number.isSafeInteger(config.dailyTransactionLimit) || config.dailyTransactionLimit < 1) {
      throw new IssuanceBudgetError('INVALID_BUDGET_CONFIG');
    }
    this.endpoint = endpoint.toString(); this.namespace = namespace; this.token = config.token;
    this.key = createHmac('sha256', config.secret).update('proofmark-issuance-budget-v1').digest();
    this.gasLimit = safeInteger(config.dailyGasLimit, 'BUDGET_CONFIG');
    if (this.gasLimit < 1) throw new IssuanceBudgetError('INVALID_BUDGET_CONFIG');
    this.transactionLimit = config.dailyTransactionLimit;
  }
  private digest(kind: string, value: string) { return createHmac('sha256', this.key).update(`${kind}|${value.toLowerCase()}`).digest('hex'); }
  private async run(op: 'reserve' | 'reconcile' | 'status', issuerInput: string, requestId = '0x' + '00'.repeat(32), amount = 0n): Promise<string[]> {
    if (!isAddress(issuerInput) || issuerInput === '0x' + '00'.repeat(20) || !REQUEST.test(requestId)) throw new IssuanceBudgetError('INVALID_BUDGET_INPUT');
    const issuer = getAddress(issuerInput), issuerKey = this.digest('issuer', issuer), requestKey = this.digest('request', requestId);
    const prefix = `{${this.namespace}:issuance-budget}:`;
    const args = ['EVAL', ISSUANCE_BUDGET_LUA, 2, `${prefix}issuer:${issuerKey}`, `${prefix}request:${requestKey}`,
      op, issuerKey, requestKey, safeInteger(amount, 'BUDGET_INPUT'), this.gasLimit, this.transactionLimit];
    try {
      const response = await this.request(this.endpoint, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(args), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error('budget unavailable');
      const body = await response.json() as { result?: unknown; error?: unknown };
      if (body.error || !Array.isArray(body.result) || !body.result.every(value => typeof value === 'string')) throw new Error('invalid budget result');
      return body.result;
    } catch (error) {
      if (error instanceof IssuanceBudgetError) throw error;
      throw new IssuanceBudgetError('BUDGET_UNAVAILABLE');
    }
  }
  private statusResult(result: string[]): IssuanceBudgetStatus {
    if (result[0] !== 'ok') throw new IssuanceBudgetError(result[0] || 'BUDGET_UNAVAILABLE');
    try {
      const gas = BigInt(result[1]), transactions = Number(result[2]);
      if (gas < 0n || !Number.isSafeInteger(transactions) || transactions < 0) throw new Error('invalid');
      return { reservedGas: gas, transactionCount: transactions };
    } catch { throw new IssuanceBudgetError('BUDGET_STATE_INVALID'); }
  }
  async reserve(input: IssuanceGasReservation) { return this.statusResult(await this.run('reserve', input.issuer, input.requestId, input.gasLimit)); }
  async reconcile(input: IssuanceGasReconciliation) {
    const result = await this.run('reconcile', input.issuer, input.requestId, input.gasUsed);
    if (result[0] !== 'ok') throw new IssuanceBudgetError(result[0] || 'BUDGET_UNAVAILABLE');
  }
  async status(issuer: string) { return this.statusResult(await this.run('status', issuer)); }
}
