import 'server-only';
import { createHmac } from 'node:crypto';
import { ethers } from 'ethers';
import { RedisIssuanceJournal, type IssuanceEntry } from '@pipeline/issuance-journal.js';
import { EvmIssuanceTransport, RotatingIssuerEvmTransport, issuanceProvider } from '@pipeline/issuance-evm.js';
import { ConfigError } from './kyc-server';
import { RedisIssuanceBudget } from '@pipeline/issuance-budget.js';
import { readOnchainState } from '@pipeline/onchain-state.js';
import type { IssuanceTrackingConfig, PolicyObservation } from '@pipeline/issuance-status.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required for recoverable issuance`, [name]);
  return value;
};
const JOURNAL_VARS = ['ISSUANCE_JOURNAL_REDIS_REST_URL', 'ISSUANCE_JOURNAL_REDIS_REST_TOKEN', 'ISSUANCE_JOURNAL_KEY'];
const BUDGET_VARS = ['ISSUANCE_JOURNAL_REDIS_REST_URL', 'ISSUANCE_JOURNAL_REDIS_REST_TOKEN', 'ISSUANCE_GAS_BUDGET_KEY',
  'ISSUANCE_DAILY_GAS_LIMIT', 'ISSUANCE_DAILY_TRANSACTION_LIMIT'];
export function issuanceJournalStatus() {
  const missing = JOURNAL_VARS.filter(name => !process.env[name]?.trim());
  return { configured: missing.length === 0, mode: missing.length ? 'none' : 'redis-encrypted', missing };
}
export function issuanceJournal(): RedisIssuanceJournal {
  return new RedisIssuanceJournal(required(JOURNAL_VARS[0]), required(JOURNAL_VARS[1]), required(JOURNAL_VARS[2]), fetch,
    process.env.ISSUANCE_JOURNAL_NAMESPACE?.trim() || 'proofmark');
}
export function issuanceBudgetStatus() {
  const missing = BUDGET_VARS.filter(name => !process.env[name]?.trim());
  return { configured: missing.length === 0, mode: missing.length ? 'none' : 'redis-daily-reservation', missing };
}
const positiveInteger = (name: string) => {
  const value = required(name);
  if (!/^\d+$/.test(value) || BigInt(value) < 1n || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConfigError(`${name} must be a positive safe integer`, [name]);
  return value;
};
export function issuanceBudget(): RedisIssuanceBudget {
  return new RedisIssuanceBudget({
    url: required(BUDGET_VARS[0]), token: required(BUDGET_VARS[1]), secret: required(BUDGET_VARS[2]),
    namespace: process.env.ISSUANCE_JOURNAL_NAMESPACE?.trim() || 'proofmark',
    dailyGasLimit: BigInt(positiveInteger(BUDGET_VARS[3])), dailyTransactionLimit: Number(positiveInteger(BUDGET_VARS[4])),
  }, fetch);
}

const TRACKING_VARS = ['ISSUANCE_SOURCE_EXPECTED_SECONDS', 'ISSUANCE_HUB_EXPECTED_SECONDS',
  'ISSUANCE_TRACKING_TIMEOUT_SECONDS', 'ISSUANCE_SUPPORT_URL'] as const;
const range = (value: string | undefined): [number, number] | null => {
  const match = value?.match(/^(\d+)-(\d+)$/);
  if (!match) return null;
  const out: [number, number] = [Number(match[1]), Number(match[2])];
  return out.every(Number.isSafeInteger) && out[0] > 0 && out[1] >= out[0] ? out : null;
};
export function issuanceTrackingStatus(): IssuanceTrackingConfig {
  const missing = TRACKING_VARS.filter(name => !process.env[name]?.trim());
  const sourceExpectedSeconds = range(process.env.ISSUANCE_SOURCE_EXPECTED_SECONDS?.trim());
  const hubExpectedSeconds = range(process.env.ISSUANCE_HUB_EXPECTED_SECONDS?.trim());
  const timeoutSeconds = Number(process.env.ISSUANCE_TRACKING_TIMEOUT_SECONDS);
  let supportUrl: string | null = null;
  try {
    const parsed = new URL(process.env.ISSUANCE_SUPPORT_URL?.trim() ?? '');
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash) supportUrl = parsed.toString();
  } catch { /* reported as invalid below */ }
  const invalid = [
    process.env.ISSUANCE_SOURCE_EXPECTED_SECONDS?.trim() && !sourceExpectedSeconds ? 'ISSUANCE_SOURCE_EXPECTED_SECONDS' : null,
    process.env.ISSUANCE_HUB_EXPECTED_SECONDS?.trim() && !hubExpectedSeconds ? 'ISSUANCE_HUB_EXPECTED_SECONDS' : null,
    process.env.ISSUANCE_TRACKING_TIMEOUT_SECONDS?.trim() && (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) ? 'ISSUANCE_TRACKING_TIMEOUT_SECONDS' : null,
    process.env.ISSUANCE_SUPPORT_URL?.trim() && !supportUrl ? 'ISSUANCE_SUPPORT_URL' : null,
  ].filter((name): name is string => !!name);
  return { configured: missing.length === 0 && invalid.length === 0, sourceExpectedSeconds,
    hubExpectedSeconds, timeoutSeconds: Number.isSafeInteger(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : null,
    supportUrl, missing, invalid };
}

export async function issuancePolicyObservation(entry: IssuanceEntry): Promise<PolicyObservation | null> {
  if (entry.phase !== 'materialized') return null;
  const registry = process.env.NEXT_PUBLIC_REGISTRY?.trim();
  if (!registry) return { status: 'unavailable', code: 'REGISTRY_NOT_CONFIGURED' };
  let provider: ethers.JsonRpcProvider | undefined;
  try {
    provider = issuanceProvider(required('NEXT_PUBLIC_CC3_RPC'));
    const state = await readOnchainState(provider, { asc: entry.target.asc, registry, subject: entry.wallet });
    return { status: 'observed', blockNumber: state.blockNumber, blockHash: state.observation.blockHash,
      observedAt: Date.now(), policies: state.policies.map(policy => ({ id: policy.id, name: policy.name,
        verified: policy.verified, reasonCodes: policy.reasonCodes })) };
  } catch { return { status: 'unavailable', code: 'POLICY_STATUS_UNAVAILABLE' }; }
  finally { provider?.destroy(); }
}
export function issuanceFingerprint(input: unknown): string {
  const secret = required('EVIDENCE_HMAC_KEY');
  if (secret.length < 32) throw new ConfigError('EVIDENCE_HMAC_KEY must be at least 32 characters', ['EVIDENCE_HMAC_KEY']);
  return createHmac('sha256', secret).update(`proofmark-issuance-input-v1|${JSON.stringify(input)}`).digest('hex');
}
export function issuanceTarget(): IssuanceEntry['target'] {
  const signer = new ethers.Wallet(required('ISSUER_PRIVATE_KEY'));
  const stable = process.env.ROTATING_ISSUER_ADDRESS?.trim();
  const epochText = process.env.ISSUER_KEY_EPOCH?.trim();
  if (!!stable !== !!epochText) throw new ConfigError('rotating issuer address and key epoch must be configured together', ['ROTATING_ISSUER_ADDRESS', 'ISSUER_KEY_EPOCH']);
  const base = { chainId: 11155111, source: ethers.getAddress(required('NEXT_PUBLIC_SOURCE')),
    hubChainId: 102031, asc: ethers.getAddress(required('NEXT_PUBLIC_ASC')) };
  if (!stable) return { ...base, issuer: signer.address, issuerMode: 'direct' };
  const issuerKeyEpoch = Number(epochText);
  if (!Number.isSafeInteger(issuerKeyEpoch) || issuerKeyEpoch < 1) throw new ConfigError('ISSUER_KEY_EPOCH must be a positive integer', ['ISSUER_KEY_EPOCH']);
  return { ...base, issuer: ethers.getAddress(stable), issuerMode: 'rotating', operatingKey: signer.address, issuerKeyEpoch };
}
export function issuanceTransport(): EvmIssuanceTransport | RotatingIssuerEvmTransport {
  const source = issuanceProvider(required('NEXT_PUBLIC_SEPOLIA_RPC'));
  const hub = issuanceProvider(required('NEXT_PUBLIC_CC3_RPC'));
  const target = issuanceTarget();
  const signer = new ethers.Wallet(required('ISSUER_PRIVATE_KEY'), source);
  const confirmations = Number(process.env.ISSUANCE_CONFIRMATIONS ?? 6);
  return target.issuerMode === 'rotating'
    ? new RotatingIssuerEvmTransport(source, hub, signer, confirmations, target)
    : new EvmIssuanceTransport(source, hub, signer, confirmations, target);
}
