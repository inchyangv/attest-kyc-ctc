import 'server-only';
import { createHmac } from 'node:crypto';
import { DemoBankStateStore, RedisBankStateStore, type BankStateStore } from '@pipeline/bank-state.js';
import { ConfigError, isDemo } from './kyc-server';

const demo = new DemoBankStateStore();
let cached: { url: string; token: string; namespace: string; store: RedisBankStateStore } | undefined;

export function bankStateStore(synthetic: boolean): BankStateStore {
  const url = process.env.BANK_STATE_REDIS_REST_URL?.trim();
  const token = process.env.BANK_STATE_REDIS_REST_TOKEN?.trim();
  const namespace = process.env.BANK_STATE_NAMESPACE?.trim() || 'proofmark';
  if (url && token) {
    if (!cached || cached.url !== url || cached.token !== token || cached.namespace !== namespace) cached = { url, token, namespace, store: new RedisBankStateStore(url, token, fetch, namespace) };
    return cached.store;
  }
  if (!url && !token && isDemo() && synthetic) return demo;
  throw new ConfigError('Bank verification requires shared atomic challenge storage before contacting a real bank.',
    ['BANK_STATE_REDIS_REST_URL', 'BANK_STATE_REDIS_REST_TOKEN'].filter(name => !process.env[name]?.trim()));
}

/** Namespace-specific keyed hashes avoid exposing wallet, account, birth date or declared name. */
export function bankStateKey(domain: string, parts: string[]): string {
  const key = process.env.EVIDENCE_HMAC_KEY?.trim();
  if (!key || key.length < 32) throw new ConfigError('EVIDENCE_HMAC_KEY is required (32+ chars)', ['EVIDENCE_HMAC_KEY']);
  return createHmac('sha256', key).update(JSON.stringify(['proofmark-bank-state-v1', domain, ...parts])).digest('hex');
}
