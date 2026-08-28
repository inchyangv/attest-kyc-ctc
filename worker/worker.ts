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
      log.info(`커서 초기화 → 블록 ${head - 1}`);
    } else {
      log.info(`커서 복원 → 블록 ${this.store.cursor} (재시작 이어받기)`);
    }

    // 재시작 시 미완료 작업을 먼저 큐에 되살린다 — 예제 워커가 놓치는 지점이다.
    const resumed = this.store.pending();
    if (resumed.length) {
      log.info(`미완료 작업 ${resumed.length}건 복원`);
      for (const j of resumed) void this.dispatch(j);
    }

    while (!this.stopping) {
      try {
        await this.scan();
      } catch (e: any) {
        log.error(`스캔 실패 (다음 주기에 재시도): ${e?.shortMessage ?? e?.message ?? e}`);
      }
      await sleep(cfg.pollMs);
    }

    log.info('종료 대기 중…');
    while (this.inFlight.size > 0) await sleep(200);
    log.info(`워커 정지. 상태: ${JSON.stringify(this.store.counts())}`);
  }

  private async preflight(): Promise<void> {
    const [sNet, hNet] = await Promise.all([this.src.getNetwork(), this.hub.getNetwork()]);
    log.info(`소스 체인 chainId=${sNet.chainId} · 허브 chainId=${hNet.chainId} · chainKey=${cfg.chainKey}`);

    // ASC 가 우리가 감시하는 소스를 실제로 신뢰하는지 확인한다.
    // 불일치하면 증명을 아무리 제출해도 UntrustedEmitter 로 전부 revert 된다.
    const [expectedKey, srcAddr] = await Promise.all([
      this.asc.expectedChainKey(),
      this.asc.sourceContract(),
    ]);
    if (Number(expectedKey) !== cfg.chainKey) {
      throw new Error(`ASC 의 expectedChainKey(${expectedKey}) 가 워커 설정(${cfg.chainKey})과 다릅니다`);
    }
    if (srcAddr.toLowerCase() !== cfg.sourceAddress.toLowerCase()) {
      throw new Error(`ASC 의 sourceContract(${srcAddr}) 가 워커 설정(${cfg.sourceAddress})과 다릅니다`);
    }
    log.ok('ASC 설정 일치 확인');
  }

  // ─────────────────────── 스캔 ───────────────────────

  private async scan(): Promise<void> {
    const head = await this.src.getBlockNumber();
    const safeHead = head - cfg.confirmations;   // 리오그 여유
    let from = this.store.cursor + 1;
    if (from > safeHead) return;

    while (from <= safeHead && !this.stopping) {
      const to = Math.min(from + cfg.scanChunk - 1, safeHead);
      const found = await this.scanRange(from, to);
      // ★ 커서는 해당 범위의 작업이 전부 영속화된 뒤에만 전진시킨다.
      //   먼저 전진시키면 크래시 시 그 구간 이벤트를 영원히 놓친다.
      this.store.setCursor(to);
      if (found) log.info(`블록 ${from}–${to} 스캔: 신규 ${found}건`);
      from = to + 1;
    }
  }

  private async scanRange(from: number, to: number): Promise<number> {
    // 컨트랙트 주소로 직접 getLogs 를 친다 — 우리 소스 컨트랙트의 모든 로그를 받아
    // 인터페이스로 파싱한다. 토픽 필터를 걸지 않아 이벤트가 추가돼도 놓치지 않는다.
    const raw = await this.src.getLogs({ address: cfg.sourceAddress, fromBlock: from, toBlock: to });

    // 한 트랜잭션의 로그를 모은다 — queryId 가 tx 단위이므로 작업도 tx 단위다.
    const byTx = new Map<string, { name: string; blockNumber: number }[]>();
    for (const l of raw) {
      let parsed: ethers.LogDescription | null = null;
      try {
        parsed = this.source.interface.parseLog({ topics: [...l.topics], data: l.data });
      } catch {
        continue; // 우리 ABI 에 없는 로그는 무시
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
        // C1 위반 — 한 tx 에 서로 다른 종류가 섞이면 하나만 처리되고 나머지는 영구 봉인된다.
        // 우리 ComplianceSource 는 이런 tx 를 만들지 않으므로, 나타났다면 설계 위반이다.
        log.error(`tx ${txHash} 에 이벤트 종류가 섞여 있습니다 (${[...names].join(', ')}) — C1 위반, 수동 확인 필요`);
        this.store.add({
          txHash, blockNumber: evs[0].blockNumber, action: -1,
          eventName: [...names].join('+'), logCount: evs.length,
          state: 'dead', attempts: 0,
          lastError: '한 tx 에 복수 이벤트 종류 (docs/04 §0 C1 위반)',
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
      log.info(`발견 ${name} ×${evs.length} — tx ${txHash.slice(0, 10)}… (블록 ${job.blockNumber})`);
      void this.dispatch(job);
    }
    return created;
  }

  // ─────────────────────── 처리 ───────────────────────

  /** 작업 하나를 독립적으로 처리한다. 하나가 죽어도 나머지는 계속 돈다. */
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
        log.error(`작업 영구 실패 tx ${job.txHash.slice(0, 10)}… (${attempts}회): ${msg}`);
      } else {
        this.store.update(job.txHash, { attempts, lastError: msg });
        log.warn(`작업 실패 tx ${job.txHash.slice(0, 10)}… (${attempts}/${cfg.maxAttempts}): ${msg} — 다음 주기에 재시도`);
        // 다음 스캔 주기에 pending() 으로 다시 잡힌다
      }
    } finally {
      this.inFlight.delete(job.txHash);
    }
  }

  private async process(job: Job): Promise<void> {
    const short = job.txHash.slice(0, 10);

    // 1. 어테스트 대기 — 폴링 실패를 흡수한다 (SDK 대체 지점)
    if (job.state === 'discovered') {
      await this.watcher.waitFor(job.blockNumber, this.abort.signal);
      this.store.update(job.txHash, { state: 'attested' });
      job.state = 'attested';
    }

    // 2. 증명 획득
    const proof = await fetchProof(cfg.proofBuilder, cfg.chainKey, job.txHash, this.abort.signal);

    // 3. ★ 멱등 — 이미 처리된 쿼리면 가스를 태우지 않고 건너뛴다
    const txIndex = txIndexFromProof(proof.merkleProof.siblings);
    const queryId = computeQueryId(proof.chainKey, proof.headerNumber, txIndex);
    if (await this.asc.processedQueries(queryId)) {
      this.store.update(job.txHash, { state: 'skipped', queryId });
      log.ok(`이미 처리된 쿼리 — 건너뜀 tx ${short}… queryId ${queryId.slice(0, 10)}…`);
      return;
    }

    // 4. 제출
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
    log.info(`제출 tx ${short}… → ASC ${resp.hash.slice(0, 10)}… (gasLimit ${gasLimit})`);

    const receipt = await resp.wait();
    if (receipt?.status !== 1) throw new Error(`ASC 트랜잭션 실패: ${resp.hash}`);

    this.store.update(job.txHash, { state: 'done' });
    log.ok(`반영 완료 ${job.eventName} ×${job.logCount} — tx ${short}… gas ${receipt.gasUsed}`);
  }

  private async estimateGas(args: readonly unknown[], continuityBlocks: number): Promise<bigint> {
    try {
      const est = await this.asc.execute.estimateGas(...(args as any));
      return (est * 135n) / 100n;   // 실측상 추정이 6.6% 과대였으나 프리컴파일 경로는 편차가 있어 버퍼 유지
    } catch (e: any) {
      // pallet-evm 은 추정 모드에서 프리컴파일 revert 사유를 제대로 전달하지 못할 때가 있다
      const fallback = BigInt(21_000 + continuityBlocks * 5_000 + 400_000);
      log.warn(`가스 추정 실패 (${e?.shortMessage ?? e?.message}) — 폴백 ${fallback} 사용`);
      return fallback;
    }
  }
}
