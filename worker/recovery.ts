import { ethers } from 'ethers';
import { HubSafetyError, type Store } from './store.js';

export interface HubRecoveryReader {
  transactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number>;
  blockNumber(): Promise<number>;
  block(height: number): Promise<{ number: number; hash: string | null } | null>;
  receipt(hash: string): Promise<{ hash: string; from: string; to: string | null; status: number | null; blockNumber: number; blockHash: string } | null>;
  processed(queryId: string, blockNumber: number): Promise<boolean>;
}

const hash = (value: string | null | undefined) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const integer = (value: number) => Number.isSafeInteger(value) && value >= 0;
const evidenceIdentity = (snapshot: ReturnType<Store['recoverySnapshot']>) => JSON.stringify({
  hubStartNonce: snapshot.hubStartNonce, hubHold: snapshot.hubHold, relay: snapshot.relay,
  terminal: Object.values(snapshot.jobs).filter(job => ['done', 'dead', 'skipped'].includes(job.state)).map(job => ({
    txHash: job.txHash, state: job.state, ascTxHash: job.ascTxHash, queryId: job.queryId,
    relayHistory: job.relayHistory, skipObservation: job.skipObservation,
  })).sort((a, b) => a.txHash.localeCompare(b.txHash)),
});

/** Explicit one-time bootstrap. The long-running worker never calls this: absence of the
 * baseline is ambiguous with state loss and therefore cannot be auto-approved at startup. */
export async function initializeHubRecovery(store: Store, hub: HubRecoveryReader): Promise<void> {
  store.assertHubReady();
  const snapshot = store.recoverySnapshot();
  if (!snapshot.scope || snapshot.hubStartNonce !== undefined || snapshot.relay
    || Object.values(snapshot.jobs).some(job => !!job.ascTxHash || !!job.relayHistory?.length
      || job.state === 'submitted' || job.state === 'done' || job.state === 'dead')) {
    store.holdHub('HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION');
  }
  const [latest, pending] = await Promise.all([
    hub.transactionCount(snapshot.scope.signer, 'latest'), hub.transactionCount(snapshot.scope.signer, 'pending'),
  ]);
  if (!integer(latest) || !integer(pending)) throw new HubSafetyError('HUB_RECOVERY_OBSERVATION_UNAVAILABLE');
  if (latest !== 0 || pending !== 0) store.holdHub('HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION');
  store.initializeHubSigner(0);
}

/**
 * Reconcile durable signer history with canonical hub state before a recovered worker may sign.
 * A missing/stale state file cannot prove ownership of already-consumed or pending nonces. Only
 * the separate explicit initializer may establish a zero-nonce dedicated signer baseline.
 */
export async function reconcileHubRecovery(store: Store, hub: HubRecoveryReader, confirmations: number): Promise<void> {
  store.assertHubReady();
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new HubSafetyError('HUB_RECOVERY_SETTINGS_INVALID');
  const snapshot = store.recoverySnapshot();
  if (!snapshot.scope) throw new HubSafetyError('HUB_RECOVERY_SCOPE_UNBOUND');
  const signer = snapshot.scope.signer.toLowerCase(), asc = snapshot.scope.asc.toLowerCase();
  const counts = async () => {
    const [latest, pending] = await Promise.all([hub.transactionCount(signer, 'latest'), hub.transactionCount(signer, 'pending')]);
    if (!integer(latest) || !integer(pending) || pending < latest) throw new HubSafetyError('HUB_RECOVERY_OBSERVATION_UNAVAILABLE');
    return { latest, pending };
  };
  if (snapshot.hubStartNonce === undefined) store.holdHub('HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION');
  const baseline = snapshot.hubStartNonce!;
  if (!integer(baseline)) store.holdHub('HUB_SIGNER_BASELINE_REQUIRES_RECONCILIATION');
  const terminal: { job: (typeof snapshot.jobs)[string]; history: NonNullable<(typeof snapshot.jobs)[string]['relayHistory']>[number] }[] = [];
  for (const job of Object.values(snapshot.jobs)) {
    const histories = job.relayHistory ?? [];
    if (job.state === 'done' || job.state === 'dead') {
      if (histories.length !== 1 || !job.queryId || !job.ascTxHash) store.holdHub('HUB_TERMINAL_HISTORY_REQUIRES_RECONCILIATION');
      terminal.push({ job, history: histories[0] });
    } else if (histories.length) store.holdHub('HUB_TERMINAL_HISTORY_REQUIRES_RECONCILIATION');
  }
  terminal.sort((a, b) => a.history.nonce - b.history.nonce);
  for (let index = 0; index < terminal.length; index++) {
    if (!integer(terminal[index].history.nonce) || terminal[index].history.nonce !== baseline + index) {
      store.holdHub('HUB_NONCE_HISTORY_REQUIRES_RECONCILIATION');
    }
  }
  const head = await hub.blockNumber();
  if (!integer(head)) throw new HubSafetyError('HUB_RECOVERY_OBSERVATION_UNAVAILABLE');
  for (const { job, history } of terminal) {
    const receipt = await hub.receipt(history.hash);
    if (!receipt || receipt.hash !== history.hash || receipt.from.toLowerCase() !== signer || receipt.to?.toLowerCase() !== asc
      || receipt.status !== (history.status === 'success' ? 1 : 0) || receipt.blockNumber !== history.blockNumber
      || receipt.blockHash !== history.blockHash || !integer(receipt.blockNumber) || !hash(receipt.blockHash)
      || head < receipt.blockNumber || head - receipt.blockNumber + 1 < confirmations) {
      store.holdHub('HUB_TERMINAL_HISTORY_NOT_CANONICAL');
    }
    const block = await hub.block(receipt.blockNumber);
    if (!block || block.number !== receipt.blockNumber || block.hash !== receipt.blockHash) store.holdHub('HUB_TERMINAL_HISTORY_NOT_CANONICAL');
    if (history.status === 'success') {
      const processed = await hub.processed(job.queryId!, receipt.blockNumber);
      if (typeof processed !== 'boolean') throw new HubSafetyError('HUB_RECOVERY_OBSERVATION_UNAVAILABLE');
      if (!processed) store.holdHub('HUB_TERMINAL_QUERY_NOT_CANONICAL');
    }
    const again = await hub.block(receipt.blockNumber);
    if (!again || again.number !== receipt.blockNumber || again.hash !== receipt.blockHash) store.holdHub('HUB_TERMINAL_HISTORY_NOT_CANONICAL');
  }
  for (const job of Object.values(snapshot.jobs)) {
    if (job.state !== 'skipped') continue;
    const observation = job.skipObservation;
    if (!observation || !job.queryId || !integer(observation.blockNumber) || !hash(observation.blockHash)
      || head < observation.blockNumber || head - observation.blockNumber + 1 < confirmations) {
      store.holdHub('HUB_SKIP_OBSERVATION_NOT_CANONICAL');
    }
    const block = await hub.block(observation.blockNumber);
    if (!block || block.number !== observation.blockNumber || block.hash !== observation.blockHash
      || !await hub.processed(job.queryId, observation.blockNumber)) store.holdHub('HUB_SKIP_OBSERVATION_NOT_CANONICAL');
    const again = await hub.block(observation.blockNumber);
    if (!again || again.number !== observation.blockNumber || again.hash !== observation.blockHash) store.holdHub('HUB_SKIP_OBSERVATION_NOT_CANONICAL');
  }
  const expected = baseline + terminal.length;
  const final = await counts();
  // Processing is concurrent with the poll-cycle audit. If the singleton sender persisted or
  // finalized an envelope during the awaits above, this sample mixed two valid state versions.
  // Discard it; the sender's own pre-sign audit or the next poll will inspect the new evidence.
  if (evidenceIdentity(store.recoverySnapshot()) !== evidenceIdentity(snapshot)) return;
  if (snapshot.relay) {
    if (snapshot.relay.nonce !== expected || ![expected, expected + 1].includes(final.latest)
      || ![expected, expected + 1].includes(final.pending)) store.holdHub('HUB_SIGNER_NONCE_DIVERGED');
  } else if (final.latest !== expected || final.pending !== expected) store.holdHub('HUB_SIGNER_NONCE_DIVERGED');
}

export class EvmHubRecoveryReader implements HubRecoveryReader {
  constructor(private readonly provider: ethers.Provider, private readonly asc: ethers.Contract) {}
  transactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number> {
    return this.provider.getTransactionCount(address, blockTag);
  }
  blockNumber(): Promise<number> { return this.provider.getBlockNumber(); }
  async block(height: number) {
    const value = await this.provider.getBlock(height);
    return value ? { number: value.number, hash: value.hash } : null;
  }
  async receipt(txHash: string) {
    const value = await this.provider.getTransactionReceipt(txHash);
    return value ? { hash: value.hash, from: value.from, to: value.to, status: value.status,
      blockNumber: value.blockNumber, blockHash: value.blockHash } : null;
  }
  processed(queryId: string, blockNumber: number): Promise<boolean> {
    return this.asc.processedQueries(queryId, { blockTag: blockNumber }) as Promise<boolean>;
  }
}
