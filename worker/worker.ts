import { ethers } from 'ethers';

import { cfg } from './config.js';
import { log } from './log.js';
import { Store, type Job } from './store.js';
import { AttestationWatcher } from './attestation.js';
import { fetchProof, computeQueryId, txIndexFromProof } from './proof.js';
import { COMPLIANCE_SOURCE_ABI, PROOFMARK_ASC_ABI, EVENT_TO_ACTION, WATCHED_EVENTS } from './abi.js';
import { sleep } from './retry.js';

export class ProofmarkWorker {
  private readonly store: Store;
  private readonly source: ethers.Contract;
  private readonly asc: ethers.Contract;
  private readonly hub: ethers.JsonRpcProvider;
  private readonly src: ethers.JsonRpcProvider;
  private readonly watcher: AttestationWatcher;
  private readonly inFlight = new Set<string>();
  private readonly abort = new AbortController();
  private stopping = false;

  constructor() {
    this.store = new Store(cfg.statePath);
    this.src = new ethers.JsonRpcProvider(cfg.sourceRpc);
    this.hub = new ethers.JsonRpcProvider(cfg.hubRpc);
    const wallet = new ethers.Wallet(cfg.privateKey, this.hub);

    this.source = new ethers.Contract(cfg.sourceAddress, COMPLIANCE_SOURCE_ABI, this.src);
    this.asc = new ethers.Contract(cfg.ascAddress, PROOFMARK_ASC_ABI, wallet);
    this.watcher = new AttestationWatcher(cfg.proofBuilder, cfg.chainKey);
  }

  stop(): void {
    this.stopping = true;
    this.abort.abort();
  }

  async run(): Promise<void> {
    await this.preflight();

    if (this.store.cursor === 0) {
      const head = cfg.startBlock || (await this.src.getBlockNumber());
      this.store.setCursor(head - 1);
      log.info(`cursor initialised at block ${head - 1}`);
    } else {
      log.info(`cursor restored at block ${this.store.cursor} (resuming)`);
    }

    // On restart, requeue unfinished jobs first. The example worker drops these.
    const resumed = this.store.pending();
    if (resumed.length) {
      log.info(`restored ${resumed.length} unfinished job(s)`);
      for (const j of resumed) void this.dispatch(j);
    }

    while (!this.stopping) {
      try {
        await this.scan();
      } catch (e: any) {
        log.error(`scan failed, retrying next cycle: ${e?.shortMessage ?? e?.message ?? e}`);
      }
      await sleep(cfg.pollMs);
    }

    log.info('종료 대기 중…');
    while (this.inFlight.size > 0) await sleep(200);
    log.info(`worker stopped. State: ${JSON.stringify(this.store.counts())}`);
  }

  private async preflight(): Promise<void> {
    const [sNet, hNet] = await Promise.all([this.src.getNetwork(), this.hub.getNetwork()]);
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
    log.ok('ASC 설정 일치 확인');
  }

  // Scan

  private async scan(): Promise<void> {
    const head = await this.src.getBlockNumber();
    const safeHead = head - cfg.confirmations;   // reorg headroom
    let from = this.store.cursor + 1;
    if (from > safeHead) return;

    while (from <= safeHead && !this.stopping) {
      const to = Math.min(from + cfg.scanChunk - 1, safeHead);
      const found = await this.scanRange(from, to);
      // Advance the cursor only after every job in the range is persisted.
      // Advance it first and a crash loses those events for good.
      this.store.setCursor(to);
      if (found) log.info(`scanned blocks ${from}-${to}: ${found} new`);
      from = to + 1;
    }
  }

  private async scanRange(from: number, to: number): Promise<number> {
    // getLogs by contract address, then parse with the interface. No topic filter, so a newly
    // added event is not silently missed.
    const raw = await this.src.getLogs({ address: cfg.sourceAddress, fromBlock: from, toBlock: to });

    // Group logs per transaction. queryId is per transaction, so a job is too.
    const byTx = new Map<string, { name: string; blockNumber: number }[]>();
    for (const l of raw) {
      let parsed: ethers.LogDescription | null = null;
      try {
        parsed = this.source.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        continue;   // ignore logs outside our ABI
      }
      if (!parsed || !WATCHED_EVENTS.includes(parsed.name)) continue;
      const arr = byTx.get(l.transactionHash) ?? [];
      arr.push({ name: parsed.name, blockNumber: l.blockNumber });
      byTx.set(l.transactionHash, arr);
    }

    let created = 0;
    for (const [txHash, evs] of byTx) {
      if (this.store.has(txHash)) continue;

      const names = new Set(evs.map((e) => e.name));
      if (names.size > 1) {
        // C1 violation. Mixed event kinds in one tx mean only one gets processed and the rest are
        // sealed forever. Our ComplianceSource never emits such a tx, so this signals a design breach.
        log.error(`tx ${txHash} carries mixed event kinds (${[...names].join(', ')}). C1 violation, needs a human.`);
        this.store.add({
          txHash, blockNumber: evs[0].blockNumber, action: -1,
          eventName: [...names].join('+'), logCount: evs.length,
          state: 'dead', attempts: 0,
          // multiple event kinds in one tx (docs/04 section 0, C1)
        });
        continue;
      }

      const name = evs[0].name;
      const job = this.store.add({
        txHash,
        blockNumber: evs[0].blockNumber,
        action: EVENT_TO_ACTION[name],
        eventName: name,
        logCount: evs.length,
        state: 'discovered',
        attempts: 0,
      });
      created++;
      log.info(`found ${name} x${evs.length} in tx ${txHash.slice(0, 10)}... (block ${job.blockNumber})`);
      void this.dispatch(job);
    }
    return created;
  }

  // Processing

  /** Each job runs on its own. One failure does not stop the rest. */
  private async dispatch(job: Job): Promise<void> {
    if (this.inFlight.has(job.txHash)) return;
    while (this.inFlight.size >= cfg.concurrency && !this.stopping) await sleep(250);
    if (this.stopping) return;

    this.inFlight.add(job.txHash);
    try {
      await this.process(job);
    } catch (e: any) {
      const msg = e?.shortMessage ?? e?.message ?? String(e);
      const attempts = (this.store.get(job.txHash)?.attempts ?? 0) + 1;
      if (attempts >= cfg.maxAttempts) {
        this.store.update(job.txHash, { state: 'dead', attempts, lastError: msg });
        log.error(`job permanently failed, tx ${job.txHash.slice(0, 10)}... after ${attempts} attempts: ${msg}`);
      } else {
        this.store.update(job.txHash, { attempts, lastError: msg });
        log.warn(`job failed, tx ${job.txHash.slice(0, 10)}... (${attempts}/${cfg.maxAttempts}): ${msg}. Retrying next cycle.`);
        // pending() picks it up again next scan
      }
    } finally {
      this.inFlight.delete(job.txHash);
    }
  }

  private async process(job: Job): Promise<void> {
    const short = job.txHash.slice(0, 10);

    // 1. wait for attestation, absorbing poll failures. This is where we replace the SDK.
    if (job.state === 'discovered') {
      await this.watcher.waitFor(job.blockNumber, this.abort.signal);
      this.store.update(job.txHash, { state: 'attested' });
      job.state = 'attested';
    }

    // 2. fetch the proof
    const proof = await fetchProof(cfg.proofBuilder, cfg.chainKey, job.txHash, this.abort.signal);

    // 3. idempotence: skip an already-processed query rather than burn gas on it
    const txIndex = txIndexFromProof(proof.merkleProof.siblings);
    const queryId = computeQueryId(proof.chainKey, proof.headerNumber, txIndex);
    if (await this.asc.processedQueries(queryId)) {
      this.store.update(job.txHash, { state: 'skipped', queryId });
      log.ok(`already processed, skipping tx ${short}... queryId ${queryId.slice(0, 10)}...`);
      return;
    }

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
    const resp = await this.asc.execute(...args, { gasLimit });
    this.store.update(job.txHash, { state: 'submitted', ascTxHash: resp.hash, queryId });
    log.info(`submitted tx ${short}... to ASC ${resp.hash.slice(0, 10)}... (gasLimit ${gasLimit})`);

    const receipt = await resp.wait();
    if (receipt?.status !== 1) throw new Error(`ASC transaction failed: ${resp.hash}`);

    this.store.update(job.txHash, { state: 'done' });
    log.ok(`applied ${job.eventName} x${job.logCount}, tx ${short}... gas ${receipt.gasUsed}`);
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
