import { ethers } from 'ethers';
import type { checkRevocation, RevocationCheckConfig } from './revocation-check.js';

export type RevocationObservation = {
  version: 1;
  operator: string;
  observedAt: number;
  config: RevocationCheckConfig;
  state: 'ENFORCED' | 'SUPERSEDED' | 'INCONSISTENT' | 'AWAITING_HUB';
  source: { transactionHash: string; blockNumber: number; blockHash: string; transactionIndex: number; receiptLogIndex: number; confirmations: number;
    head: { blockNumber: number; blockHash: string; timestamp: number } };
  hub: { blockNumber: number; blockHash: string; timestamp: number; tombstone: boolean;
    cursor: { height: string; transactionIndex: string; receiptLogIndex: string }; policies: { id: number; verified: boolean }[] };
};

export class RevocationObservationError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RevocationObservationError'; }
}
function requireThat(ok: unknown): asserts ok { if (!ok) throw new RevocationObservationError('INVALID_REVOCATION_OBSERVATION'); }
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
function hash(value: string) { requireThat(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)); return value.toLowerCase(); }
function address(value: string) { requireThat(ethers.isAddress(value) && value.toLowerCase() !== ethers.ZeroAddress); return value.toLowerCase(); }
function coordinate(value: string, bits: number) {
  requireThat(typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value) && BigInt(value) < 1n << BigInt(bits)); return value;
}

/** Internal schema/projection boundary, not an independent RPC proof or operator authentication. */
export function normalizeRevocationObservation(value: RevocationObservation): RevocationObservation {
  requireThat(value.version === 1 && typeof value.operator === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.operator));
  requireThat(integer(value.observedAt) && value.observedAt > 0 && value.observedAt <= Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    && integer(value.config.confirmations) && value.config.confirmations > 0);
  const c = value.config, s = value.source, h = value.hub;
  requireThat(Array.isArray(c.policyIds) && c.policyIds.length > 0 && c.policyIds.length <= 16
    && c.policyIds.every(id => integer(id) && id > 0) && new Set(c.policyIds).size === c.policyIds.length);
  requireThat([s.blockNumber, s.transactionIndex, s.receiptLogIndex, s.confirmations, s.head.blockNumber, s.head.timestamp, h.blockNumber, h.timestamp].every(integer)
    && s.confirmations >= c.confirmations && h.timestamp > 0 && h.timestamp <= value.observedAt + 30 && value.observedAt - h.timestamp <= 300);
  requireThat(s.head.blockNumber >= s.blockNumber && s.head.blockNumber - s.blockNumber + 1 === s.confirmations
    && s.head.timestamp > 0 && s.head.timestamp <= value.observedAt + 30 && value.observedAt - s.head.timestamp <= 300);
  requireThat(typeof h.tombstone === 'boolean' && h.policies.length === c.policyIds.length);
  const policies = h.policies.map((policy, i) => {
    requireThat(policy.id === c.policyIds[i] && typeof policy.verified === 'boolean');
    return { id: policy.id, verified: policy.verified };
  });
  const cursor = { height: coordinate(h.cursor.height, 64), transactionIndex: coordinate(h.cursor.transactionIndex, 64), receiptLogIndex: coordinate(h.cursor.receiptLogIndex, 256) };
  const a = [BigInt(cursor.height), BigInt(cursor.transactionIndex), BigInt(cursor.receiptLogIndex)];
  const b = [BigInt(s.blockNumber), BigInt(s.transactionIndex), BigInt(s.receiptLogIndex)];
  const first = a.findIndex((value, i) => value !== b[i]);
  const state = first < 0 ? h.tombstone && policies.every(p => !p.verified) ? 'ENFORCED' : 'INCONSISTENT'
    : a[first] > b[first] ? 'SUPERSEDED' : 'AWAITING_HUB';
  requireThat(value.state === state);
  return { version: 1, operator: value.operator, observedAt: value.observedAt, state,
    config: { source: address(c.source), asc: address(c.asc), registry: address(c.registry), expectedRevoker: address(c.expectedRevoker),
      sourceCodeHash: hash(c.sourceCodeHash), ascCodeHash: hash(c.ascCodeHash), registryCodeHash: hash(c.registryCodeHash),
      policyIds: [...c.policyIds], confirmations: c.confirmations },
    source: { transactionHash: hash(s.transactionHash), blockNumber: s.blockNumber, blockHash: hash(s.blockHash),
      transactionIndex: s.transactionIndex, receiptLogIndex: s.receiptLogIndex, confirmations: s.confirmations,
      head: { blockNumber: s.head.blockNumber, blockHash: hash(s.head.blockHash), timestamp: s.head.timestamp } },
    hub: { blockNumber: h.blockNumber, blockHash: hash(h.blockHash), timestamp: h.timestamp, tombstone: h.tombstone, cursor, policies } };
}

export function revocationObservation(result: Awaited<ReturnType<typeof checkRevocation>>, config: RevocationCheckConfig, operator: string): RevocationObservation {
  if (!result.source || !result.hub || !result.observedAt) throw new RevocationObservationError('INCOMPLETE_REVOCATION_OBSERVATION');
  return normalizeRevocationObservation({ version: 1, operator, observedAt: result.observedAt, config,
    state: result.state as RevocationObservation['state'], source: result.source, hub: result.hub });
}
