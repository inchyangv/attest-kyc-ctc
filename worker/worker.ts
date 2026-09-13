import { ethers } from 'ethers';
import { dirname, join, resolve } from 'node:path';

import { cfg } from './config.js';
import { log } from './log.js';
import { Store, StoreWriteError, SourceSafetyError, HubSafetyError, jobsReadyForDispatch, type Job } from './store.js';
import { AttestationWatcher } from './attestation.js';
import { fetchProof, computeQueryId, txIndexFromProof } from './proof.js';
import { COMPLIANCE_SOURCE_ABI, PROOFMARK_ASC_ABI, requireIssuerKeyProvenance, requireDenialCorrection } from './abi.js';
import { requireAtomicReceipts } from './source-events.js';
import { requireEpochV2 } from '../pipeline/epoch.js';
import { requireRosterAuthorization } from '../pipeline/roster-authorization.js';
import { scanSourceStep } from './source-scan.js';
import { sleep, throwIfStopped } from './retry.js';
import { BoundedPool } from './pool.js';
import { RelaySender, RelayBusy, EvmRelayTransport } from './relay.js';
import { acquireWorkerLease } from './lease.js';
import { WorkerHealth, serveWorkerHealth } from './health.js';
import { EvmHubRecoveryReader, reconcileHubRecovery } from './recovery.js';

export class ProofmarkWorker {
  private readonly store: Store;
  private readonly source: ethers.Contract;
  private readonly asc: ethers.Contract;
  private readonly hub: ethers.JsonRpcProvider;
  private readonly src: ethers.JsonRpcProvider;
  private readonly watcher: AttestationWatcher;
  private readonly wallet: ethers.Wallet;
  private readonly sender: RelaySender;
  private readonly hubRecovery: EvmHubRecoveryReader;
  private fatalError: unknown;
  private readonly pool = new BoundedPool(cfg.concurrency, error => {
    this.fatalError = error; this.stop();
    log.error('dispatch persistence/reporting failed; stopping for reconciliation');
  });
  private readonly abort = new AbortController();
  private stopping = false;
  private readonly health = cfg.health ? new WorkerHealth(cfg.health.maxScanAgeMs) : undefined;

  constructor() {
    this.store = new Store(cfg.statePath);
    const provider = (url: string) => { const request = new ethers.FetchRequest(url); request.timeout = 15_000; return new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1 }); };
    this.src = provider(cfg.sourceRpc);
    this.hub = provider(cfg.hubRpc);
    this.wallet = new ethers.Wallet(cfg.privateKey, this.hub);

    this.source = new ethers.Contract(cfg.sourceAddress, COMPLIANCE_SOURCE_ABI, this.src);
    this.asc = new ethers.Contract(cfg.ascAddress, PROOFMARK_ASC_ABI, this.wallet);
    this.hubRecovery = new EvmHubRecoveryReader(this.hub, this.asc);
    this.sender = new RelaySender(this.store, new EvmRelayTransport(this.hub, this.wallet, this.asc, cfg.hubConfirmations), async id => {
      throwIfStopped(this.abort.signal);
      const job = this.store.get(id);
      if (!job) throw new SourceSafetyError('SOURCE_JOB_NOT_RUNNABLE');
      await this.assertCanonicalJob(job);
    }, this.abort.signal, () => reconcileHubRecovery(this.store, this.hubRecovery, cfg.hubConfirmations));
    this.watcher = new AttestationWatcher(cfg.proofBuilder, cfg.chainKey);
  }

  stop(): void {
    this.health?.stopping();
    this.stopping = true;
    this.pool.stop();
    this.abort.abort();
  }

  async run(): Promise<void> {
    const releases: (() => void)[] = [];
    let healthServer: Awaited<ReturnType<typeof serveWorkerHealth>> | undefined;
    try {
      const path = resolve(cfg.statePath);
      releases.push(acquireWorkerLease(`${path}.lock`));
      releases.push(acquireWorkerLease(join(dirname(path), `relay-102031-${this.wallet.address.toLowerCase()}.lock`)));
      this.store.reload();
      if (this.health && cfg.health) healthServer = await serveWorkerHealth(this.health, cfg.health.port, () => this.pool.size);
      await this.runLoop();
    } finally {
      this.stop(); await this.pool.drain();
      this.src.destroy(); this.hub.destroy();
      try { await healthServer?.close(); }
      finally { for (const release of releases.reverse()) release(); }
    }
  }

  private async runLoop(): Promise<void> {
    await this.preflight();
    this.health?.running();

    // Validate/reconcile source checkpoints before starting any restored job or signed replay.
    await reconcileHubRecovery(this.store, this.hubRecovery, cfg.hubConfirmations);
    await this.scan();

    while (!this.stopping) {
      try {
        await reconcileHubRecovery(this.store, this.hubRecovery, cfg.hubConfirmations);
        await this.scan();
      } catch (e: any) {
        if (e instanceof StoreWriteError || e instanceof SourceSafetyError || e instanceof HubSafetyError) { this.stop(); throw e; }
        log.error(`scan failed, retrying next cycle: ${e?.shortMessage ?? e?.message ?? e}`);
      }
      // A failed dispatch stays persisted as pending. Requeue on every cycle, including cycles
      // with no new blocks; startup-only requeue would otherwise strand it until a restart.
      this.schedulePending();
      try { await sleep(cfg.pollMs, this.abort.signal); }
      catch (error) { if (!this.stopping) throw error; }
    }

    log.info('waiting for in-flight work...');
    await this.pool.drain();
    if (this.fatalError) throw this.fatalError;
    log.info(`worker stopped. State: ${JSON.stringify(this.store.counts())}`);
  }

  private async preflight(): Promise<void> {
    await requireAtomicReceipts(() => this.asc.TRANSACTION_PROCESSING_VERSION());
    await requireEpochV2(() => this.source.EPOCH_SCHEMA_VERSION(), () => this.asc.EPOCH_SCHEMA_VERSION());
    await requireRosterAuthorization(() => this.source.ROSTER_AUTH_VERSION(), () => this.asc.ROSTER_AUTH_VERSION());
    await requireIssuerKeyProvenance(
      () => this.source.ISSUER_KEY_PROVENANCE_VERSION(), () => this.asc.ISSUER_KEY_PROVENANCE_VERSION(),
    );
    await requireDenialCorrection(
      () => this.source.DENIAL_CORRECTION_VERSION(), () => this.asc.DENIAL_CORRECTION_VERSION(),
    );
    const [sNet, hNet] = await Promise.all([this.src.getNetwork(), this.hub.getNetwork()]);
    if (sNet.chainId !== 11155111n || hNet.chainId !== 102031n || cfg.chainKey !== 1) throw new Error('unsupported worker source/hub chain binding');
    log.info(`source chainId=${sNet.chainId} hub chainId=${hNet.chainId} chainKey=${cfg.chainKey}`);

    // Check the ASC actually trusts the source we watch.
    // If it does not, every proof we submit reverts with UntrustedEmitter.
    const [expectedKey, srcAddr] = await Promise.all([
      this.asc.expectedChainKey(),
      this.asc.sourceContract(),
    ]);
    if (Number(expectedKey) !== cfg.chainKey) {
      throw new Error(`ASC expectedChainKey (${expectedKey}) does not match worker config (${cfg.chainKey})`);
    }
    if (srcAddr.toLowerCase() !== cfg.sourceAddress.toLowerCase()) {
      throw new Error(`ASC sourceContract (${srcAddr}) does not match worker config (${cfg.sourceAddress})`);
    }
    this.store.bindScope({ sourceChainId: 11155111, hubChainId: 102031, chainKey: cfg.chainKey,
      source: cfg.sourceAddress.toLowerCase(), asc: cfg.ascAddress.toLowerCase(), signer: this.wallet.address.toLowerCase(), startBlock: cfg.startBlock });
    log.ok('ASC configuration matches');
  }

  // Scan

  private async scan(): Promise<void> {
    try {
      while (!this.stopping) {
        const result = await scanSourceStep(this.store, this.src, this.source.interface, {
          address: cfg.sourceAddress, startBlock: cfg.startBlock, confirmations: cfg.confirmations, chunk: cfg.scanChunk,
          beforeRewind: () => {
            if (this.pool.size) { this.stop(); throw new SourceSafetyError('SOURCE_REORG_DRAIN_AND_RESTART_REQUIRED'); }
          },
        });
        if (this.store.checkpoints.length) this.health?.scanCompleted();
        if (result.rewound) log.warn(`discarded ${result.rewound} unsigned orphan job(s); rescanning source history`);
        this.schedulePending();
        if (!result.scanned) break;
        log.info(`source checkpoint ${this.store.cursor}: ${result.jobs} job(s)`);
      }
    } catch (error) { this.health?.scanError(); throw error; }
  }

  private async assertCanonicalJob(job: Job): Promise<void> {
    this.store.assertSourceReady();
    if (!job.blockHash || !Number.isSafeInteger(job.transactionIndex)) throw new SourceSafetyError('SOURCE_JOB_MISSING_HASH_COORDINATES');
    const [block, finalized] = await Promise.all([this.src.getBlock(job.blockNumber), this.src.getBlock('finalized')]);
    if (!block?.hash || block.number !== job.blockNumber || !finalized?.hash || finalized.number < job.blockNumber) {
      throw new SourceSafetyError('SOURCE_JOB_CANONICALITY_UNCONFIRMED');
    }
    if (block.hash !== job.blockHash) {
      if (job.ascTxHash) this.store.holdSource('SOURCE_REORG_TOUCHES_RELAYED_JOB');
      throw new SourceSafetyError('SOURCE_JOB_NOT_CANONICAL_FINALIZED');
    }
    throwIfStopped(this.abort.signal);
  }

  // Processing

  private schedulePending(): void {
    for (const job of jobsReadyForDispatch(this.store, this.pool, this.pool.available)) this.dispatch(job);
  }

  /** Repeated scans never create capacity waiters. Unreserved jobs remain solely in Store. */
  private dispatch(job: Job): void {
    if (this.stopping) return;
    this.pool.tryRun(job.txHash, async () => {
      const current = this.store.get(job.txHash);
      // State may have changed since discovery/reservation. Do not execute terminal snapshots.
      if (!current || ['done', 'dead', 'skipped'].includes(current.state) || this.stopping) return;
      await this.processReserved(current);
    });
  }

  private async processReserved(job: Job): Promise<void> {
    try {
      await this.process(job);
    } catch (e: any) {
      if (e instanceof StoreWriteError || e instanceof SourceSafetyError) { this.stop(); throw e; }
      if (this.stopping) return;
      if (e instanceof RelayBusy) return;
      if (this.store.relay?.sourceTxHash === job.txHash) {
        this.store.update(job.txHash, { state: 'submitted', lastError: 'RELAY_RECONCILIATION_PENDING' });
        log.warn(`relay receipt unresolved for ${job.txHash.slice(0, 10)}; no new signer nonce will be allocated`);
        return;
      }
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      const attempts = (this.store.get(job.txHash)?.attempts ?? 0) + 1;
      if (attempts >= cfg.maxAttempts) {
        this.store.update(job.txHash, { state: 'dead', attempts, lastError: msg });
        log.error(`job permanently failed, tx ${job.txHash.slice(0, 10)}... after ${attempts} attempts: ${msg}`);
      } else {
        this.store.update(job.txHash, { attempts, lastError: msg });
        log.warn(`job failed, tx ${job.txHash.slice(0, 10)}... (${attempts}/${cfg.maxAttempts}): ${msg}. Retrying next cycle.`);
        // run() picks it up on the next polling cycle, even if no new source block arrives
      }
    }
  }

  private async process(job: Job): Promise<void> {
    const short = job.txHash.slice(0, 10);
    if (this.store.relay?.sourceTxHash === job.txHash) {
      await this.sender.step(job.txHash); return;
    }
    if (this.store.relay) throw new RelayBusy();
    if (job.state === 'submitted' || job.ascTxHash) throw new Error('LEGACY_SUBMISSION_REQUIRES_RECONCILIATION');
    await this.assertCanonicalJob(job);

    // 1. wait for attestation, absorbing poll failures. This is where we replace the SDK.
    if (job.state === 'discovered') {
      await this.watcher.waitFor(job.blockNumber, this.abort.signal);
      await this.assertCanonicalJob(job);
      this.store.update(job.txHash, { state: 'attested' });
      job.state = 'attested';
    }

    // 2. fetch the proof
    const proof = await fetchProof(cfg.proofBuilder, cfg.chainKey, job.txHash, this.abort.signal);
    if (proof.chainKey !== cfg.chainKey || proof.headerNumber !== job.blockNumber) throw new Error('SOURCE_PROOF_COORDINATE_CHANGED');

    // 3. Recover the query identity; only the sender's depth/hash-bound path may skip it.
    const txIndex = txIndexFromProof(proof.merkleProof.siblings);
    if (txIndex !== BigInt(job.transactionIndex!)) throw new SourceSafetyError('SOURCE_PROOF_TX_INDEX_CHANGED');
    const queryId = computeQueryId(proof.chainKey, proof.headerNumber, txIndex);

    // 4. submit
    const args = [
      job.action,
      proof.chainKey,
      proof.headerNumber,
      proof.txBytes,
      proof.merkleProof.root,
      proof.merkleProof.siblings,
      proof.continuityProof.lowerEndpointDigest,
      proof.continuityProof.roots,
    ] as const;

    const gasLimit = await this.estimateGas(args, proof.continuityProof.roots?.length ?? 1);
    if (this.stopping) return;
    await this.sender.step(job.txHash, { queryId, data: this.asc.interface.encodeFunctionData('execute', args), gasLimit });
    log.info(`relay ${short}... state=${this.store.get(job.txHash)?.state}`);
  }

  private async estimateGas(args: readonly unknown[], continuityBlocks: number): Promise<bigint> {
    try {
      const est = await this.asc.execute.estimateGas(...(args as any));
      return (est * 135n) / 100n;   // estimation ran 6.6% high in our measurement, but precompile paths vary, so keep the buffer
    } catch (e: any) {
      // pallet-evm sometimes loses precompile revert reasons in estimation mode
      const fallback = BigInt(21_000 + continuityBlocks * 5_000 + 400_000);
      log.warn(`gas estimation failed (${e?.shortMessage ?? e?.message}), falling back to ${fallback}`);
      return fallback;
    }
  }
}
