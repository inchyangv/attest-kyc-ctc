import { ethers } from 'ethers';
import { Store, type RelayEnvelope } from './store.js';
import { throwIfStopped } from './retry.js';

export class RelayBusy extends Error { constructor() { super('RELAY_NONCE_UNRESOLVED'); } }
export type QueryObservation = { status: 'unprocessed' | 'pending' | 'confirmed'; blockNumber: number; blockHash: string; confirmations: number; observedAt: number };
export interface RelayTransport {
  processed(queryId: string, blockNumber?: number): Promise<boolean>;
  observeProcessed(queryId: string, expected?: QueryObservation): Promise<QueryObservation>;
  prepare(sourceTxHash: string, queryId: string, data: string, gasLimit: bigint): Promise<RelayEnvelope>;
  receipt(relay: RelayEnvelope): Promise<{ status: 'pending' } | { status: 'success' | 'reverted'; blockNumber: number; blockHash: string }>;
  broadcast(relay: RelayEnvelope): Promise<void>;
}

/** Parallel proof preparation, one unresolved signer nonce. The synchronous reservation also
 * protects the gap between reading the pending nonce and durably saving the signature. */
export class RelaySender {
  private active = false;
  constructor(private readonly store: Store, private readonly transport: RelayTransport,
    private readonly guardSource: (sourceTxHash: string) => Promise<void> = async () => {},
    private readonly signal?: AbortSignal,
    private readonly guardHub: () => Promise<void> = async () => {}) {}

  async step(sourceTxHash: string, preparation?: { queryId: string; data: string; gasLimit: bigint }): Promise<void> {
    throwIfStopped(this.signal);
    if (this.active || (this.store.relay && this.store.relay.sourceTxHash !== sourceTxHash)) throw new RelayBusy();
    this.active = true;
    try {
      this.store.assertSourceReady(); this.store.assertHubReady();
      const job = this.store.get(sourceTxHash);
      if (!job || ['done', 'dead', 'skipped'].includes(job.state)) throw new Error('RELAY_JOB_NOT_PENDING');
      let relay = this.store.relay;
      if (!relay) {
        if (!preparation) throw new Error('RELAY_PREPARATION_REQUIRED');
        await this.guardHub();
        throwIfStopped(this.signal); this.store.assertHubReady();
        const query = await this.transport.observeProcessed(preparation.queryId);
        if (query.status === 'pending') return;
        if (query.status === 'confirmed') {
          await this.guardSource(sourceTxHash);
          const final = await this.transport.observeProcessed(preparation.queryId, query);
          if (final.status !== 'confirmed' || final.blockNumber !== query.blockNumber || final.blockHash !== query.blockHash) return;
          throwIfStopped(this.signal); this.store.assertSourceReady();
          this.store.update(sourceTxHash, { state: 'skipped', queryId: preparation.queryId,
            skipObservation: { blockNumber: final.blockNumber, blockHash: final.blockHash, confirmations: final.confirmations, observedAt: final.observedAt } }); return;
        }
        await this.guardSource(sourceTxHash);
        relay = await this.transport.prepare(sourceTxHash, preparation.queryId, preparation.data, preparation.gasLimit);
        if (relay.sourceTxHash !== sourceTxHash || relay.queryId !== preparation.queryId || relay.data !== preparation.data) throw new Error('RELAY_PREPARATION_CONFLICT');
        await this.guardSource(sourceTxHash);
        this.store.reserveRelay(relay); // No broadcast if this throws, even after a committed rename.
      }
      let receipt = await this.transport.receipt(relay);
      if (receipt.status === 'pending') {
        await this.guardSource(sourceTxHash);
        this.store.assertSourceReady();
        try { await this.transport.broadcast(relay); }
        catch { this.store.update(sourceTxHash, { lastError: 'ASC_BROADCAST_UNCONFIRMED' }); }
        receipt = await this.transport.receipt(relay);
      }
      if (receipt.status === 'pending') return;
      await this.guardSource(sourceTxHash);
      if (receipt.status === 'success' && !await this.transport.processed(relay.queryId, receipt.blockNumber)) throw new Error('ASC_QUERY_NOT_CONFIRMED');
      // Source/query RPCs above may have taken time. Never release a nonce using only the
      // earlier receipt observation, including confirmed reverts that skip the query read.
      const finalReceipt = await this.transport.receipt(relay);
      if (finalReceipt.status === 'pending' || finalReceipt.status !== receipt.status
        || finalReceipt.blockNumber !== receipt.blockNumber || finalReceipt.blockHash !== receipt.blockHash) return;
      throwIfStopped(this.signal); this.store.assertSourceReady(); this.store.assertHubReady();
      this.store.finishRelay(relay.hash, receipt);
    } finally { this.active = false; }
  }
}

export function validateRelay(relay: RelayEnvelope, chainId: bigint, asc: string, signer: string): void {
  const tx = ethers.Transaction.from(relay.raw);
  if (!tx.isSigned() || tx.hash !== relay.hash || tx.nonce !== relay.nonce || tx.chainId !== chainId
    || relay.chainId !== Number(chainId) || tx.to?.toLowerCase() !== asc.toLowerCase() || relay.to.toLowerCase() !== asc.toLowerCase()
    || tx.from.toLowerCase() !== signer.toLowerCase() || relay.signer.toLowerCase() !== signer.toLowerCase()
    || tx.data !== relay.data || tx.value !== 0n) throw new Error('RELAY_SIGNATURE_TARGET_MISMATCH');
}

export class EvmRelayTransport implements RelayTransport {
  constructor(private readonly provider: ethers.Provider, private readonly wallet: ethers.Wallet, private readonly asc: ethers.Contract, private readonly confirmations: number) {
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('invalid relay confirmation depth');
  }
  async processed(queryId: string, blockNumber?: number): Promise<boolean> {
    return blockNumber === undefined ? this.asc.processedQueries(queryId) : this.asc.processedQueries(queryId, { blockTag: blockNumber });
  }
  /** Observe positive query state at sufficient depth, then bind any recheck to that same block. */
  async observeProcessed(queryId: string, expected?: QueryObservation): Promise<QueryObservation> {
    const head = await this.provider.getBlockNumber();
    if (!Number.isSafeInteger(head) || head < 0) throw new Error('ASC_QUERY_OBSERVATION_UNAVAILABLE');
    const sample = async (height: number, expectedHash?: string) => {
      const block = await this.provider.getBlock(height);
      if (!block || block.number !== height || !/^0x[0-9a-fA-F]{64}$/.test(block.hash ?? '')
        || (expectedHash !== undefined && block.hash !== expectedHash)) throw new Error('ASC_QUERY_OBSERVATION_CHANGED');
      const value = await this.processed(queryId, height);
      if (typeof value !== 'boolean') throw new Error('ASC_QUERY_OBSERVATION_UNAVAILABLE');
      const finalHead = await this.provider.getBlockNumber();
      const again = await this.provider.getBlock(height);
      if (!again || again.number !== height || again.hash !== block.hash || !Number.isSafeInteger(finalHead) || finalHead < height) {
        throw new Error('ASC_QUERY_OBSERVATION_CHANGED');
      }
      return { value, blockNumber: height, blockHash: block.hash!, confirmations: finalHead - height + 1, observedAt: Date.now() };
    };
    if (expected) {
      if (expected.status !== 'confirmed' || !Number.isSafeInteger(expected.blockNumber) || expected.blockNumber < 0
        || !/^0x[0-9a-fA-F]{64}$/.test(expected.blockHash)) throw new Error('ASC_QUERY_OBSERVATION_UNAVAILABLE');
      if (head - expected.blockNumber + 1 < this.confirmations) return { ...expected, status: 'pending' };
      const result = await sample(expected.blockNumber, expected.blockHash);
      const { value, ...observation } = result;
      return { ...observation, status: value && result.confirmations >= this.confirmations ? 'confirmed' : 'pending' };
    }
    const latest = await sample(head);
    const { value, ...latestObservation } = latest;
    if (!value) return { ...latestObservation, status: 'unprocessed' };
    const height = head - this.confirmations + 1;
    if (height < 0) return { ...latestObservation, status: 'pending' };
    // A newly deployed ASC may not yet exist at the confirmation floor. It is not a negative query verdict.
    if (await this.provider.getCode(await this.asc.getAddress(), height) === '0x') return { ...latestObservation, status: 'pending' };
    const stable = height === head ? latest : await sample(height);
    const { value: confirmed, ...observation } = stable;
    return { ...observation, status: confirmed && stable.confirmations >= this.confirmations ? 'confirmed' : 'pending' };
  }
  async prepare(sourceTxHash: string, queryId: string, data: string, gasLimit: bigint): Promise<RelayEnvelope> {
    const to = await this.asc.getAddress();
    const tx = await this.wallet.populateTransaction({ to, data, gasLimit, value: 0n });
    const raw = await this.wallet.signTransaction(tx);
    const relay = { sourceTxHash, queryId, data, raw, hash: ethers.keccak256(raw), nonce: Number(tx.nonce), chainId: Number(tx.chainId), to, signer: this.wallet.address };
    validateRelay(relay, 102031n, to, this.wallet.address); return relay;
  }
  async receipt(relay: RelayEnvelope) {
    validateRelay(relay, 102031n, await this.asc.getAddress(), this.wallet.address);
    const r = await this.provider.getTransactionReceipt(relay.hash);
    if (!r) return { status: 'pending' as const };
    if (!Number.isSafeInteger(r.blockNumber) || r.blockNumber < 0 || !/^0x[0-9a-fA-F]{64}$/.test(r.blockHash)) throw new Error('RELAY_RECEIPT_MISMATCH');
    const [block, head] = await Promise.all([this.provider.getBlock(r.blockNumber), this.provider.getBlockNumber()]);
    if (!Number.isSafeInteger(head) || head < r.blockNumber || !block || block.number !== r.blockNumber
      || block.hash !== r.blockHash || head - r.blockNumber + 1 < this.confirmations) return { status: 'pending' as const };
    if (r.hash !== relay.hash || r.from.toLowerCase() !== relay.signer.toLowerCase() || r.to?.toLowerCase() !== relay.to.toLowerCase()
      || (r.status !== 0 && r.status !== 1)) throw new Error('RELAY_RECEIPT_MISMATCH');
    const checked = await this.provider.getBlock(r.blockNumber);
    if (!checked || checked.number !== r.blockNumber || checked.hash !== r.blockHash) return { status: 'pending' as const };
    return { status: r.status === 1 ? 'success' as const : 'reverted' as const, blockNumber: r.blockNumber, blockHash: r.blockHash };
  }
  async broadcast(relay: RelayEnvelope): Promise<void> {
    validateRelay(relay, 102031n, await this.asc.getAddress(), this.wallet.address);
    const response = await this.provider.broadcastTransaction(relay.raw);
    if (response.hash !== relay.hash) throw new Error('RELAY_BROADCAST_HASH_MISMATCH');
  }
}
