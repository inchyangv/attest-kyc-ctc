/** Synthetic local scale measurement, not production latency, CC3 price or customer demand. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { ethers } from 'ethers';
import { bundleFixture } from '../test/fixtures/roster-bundle.js';
import { exportRosterBundle, loadRosterBundle, MAX_BUNDLE_ENTRIES } from '../pipeline/roster-bundle.js';
import { rosterLeaf, subjectKey } from '../pipeline/roster.js';
import { rosterProofServer } from '../pipeline/roster-proof-server.js';
import { buildSourceRoster, type SnapshotHeaderReader, type SnapshotReader } from '../pipeline/roster-source.js';
import { packAttrs } from '../pipeline/attrs.js';

const args = process.argv.slice(2);
if (args.some(a => a.startsWith('--') && !['--gas', '--http', '--source-replay', '--write'].includes(a))) {
  throw new Error('usage: benchmark-roster-bundle.ts [counts...] [--gas] [--http] [--source-replay] [--write]');
}
const raw = args.filter(a => !a.startsWith('--'));
const counts = (raw.length ? raw : ['1000', '10000']).map(n => {
  if (!/^[1-9][0-9]*$/.test(n) || Number(n) > MAX_BUNDLE_ENTRIES) throw new Error(`count must be 1..${MAX_BUNDLE_ENTRIES}`);
  return Number(n);
});
let anvil: ReturnType<typeof spawn> | undefined, provider: ethers.JsonRpcProvider | undefined;
let cost: ethers.Contract | undefined, signer: ethers.Wallet | undefined;

const percentile = (values: number[], index: number) => [...values].sort((a, b) => a - b)[index];

async function httpBenchmark(bundle: ReturnType<typeof loadRosterBundle>, contentHash: string, subject: string) {
  const server = rosterProofServer(bundle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const samples = 96, concurrency = 16;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/rosters/${contentHash}/proof/${subject}`;
    const durations: number[] = [];
    let next = 0, failures = 0;
    const started = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= samples) return;
        const then = performance.now();
        try {
          const response = await fetch(url);
          if (response.status !== 200 || (await response.json() as { kind?: string }).kind !== 'inclusion') failures++;
        } catch { failures++; }
        durations.push(performance.now() - then);
      }
    }));
    const elapsedMs = performance.now() - started;
    return { transport: 'localhost-http', samples, concurrency, failures, elapsedMs,
      requestsPerSecond: samples * 1000 / elapsedMs,
      latencyMs: { p50: percentile(durations, 47), p95: percentile(durations, 90), p99: percentile(durations, 94) } };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function sourceReplayBenchmark(count: number) {
  if (!provider || !signer) throw new Error('local source benchmark unavailable');
  const artifact = JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8'));
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy(signer.address);
  await deployed.waitForDeployment();
  const deploymentTx = deployed.deploymentTransaction()!.hash;
  const source = new ethers.Contract(await deployed.getAddress(), artifact.abi, signer);
  await (await source.setIssuer(signer.address, true)).wait();
  await (await source.setEpochPublisher(signer.address, true)).wait();
  const sourceAddress = await source.getAddress();
  const timestamp = (await provider.getBlock('latest'))!.timestamp;
  const attrs = packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410, methods: 65572,
    issuedAt: timestamp, expiry: timestamp + 86400, epoch: 0 });
  let issuanceGas = 0n, issuanceTransactions = 0;
  for (let offset = 0; offset < count; offset += 100) {
    const items = Array.from({ length: Math.min(100, count - offset) }, (_, i) => {
      const n = offset + i + 1;
      return { subject: ethers.toBeHex(n, 20), attrs, claimsRoot: ethers.id(`claims-${n}`), evidenceHash: ethers.id(`evidence-${n}`) };
    });
    const receipt = await (await source.issueBatch(items)).wait();
    if (!receipt || receipt.status !== 1) throw new Error('local synthetic source issuance failed');
    issuanceGas += receipt.gasUsed; issuanceTransactions++;
  }
  await provider.send('anvil_mine', ['0x50']);
  const calls = { primaryNetwork: 0, primaryHead: 0, primaryBlocks: 0, primaryReceipts: 0, primaryLogs: 0,
    headerNetwork: 0, headerHead: 0, headerBlocks: 0 };
  const primary: SnapshotReader = {
    getNetwork: async () => { calls.primaryNetwork++; return provider!.getNetwork(); },
    getBlockNumber: async () => { calls.primaryHead++; return provider!.getBlockNumber(); },
    getBlock: async tag => { calls.primaryBlocks++; return await provider!.getBlock(tag) as unknown as Awaited<ReturnType<SnapshotReader['getBlock']>>; },
    getTransactionReceipt: async hash => { calls.primaryReceipts++; return await provider!.getTransactionReceipt(hash) as unknown as Awaited<ReturnType<SnapshotReader['getTransactionReceipt']>>; },
    getLogs: async filter => { calls.primaryLogs++; return await provider!.getLogs(filter) as unknown as Awaited<ReturnType<SnapshotReader['getLogs']>>; },
  };
  const headers: SnapshotHeaderReader = {
    getNetwork: async () => { calls.headerNetwork++; return provider!.getNetwork(); },
    getBlockNumber: async () => { calls.headerHead++; return provider!.getBlockNumber(); },
    getBlock: async tag => { calls.headerBlocks++; return await provider!.getBlock(tag) as unknown as Awaited<ReturnType<SnapshotHeaderReader['getBlock']>>; },
  };
  const started = performance.now();
  const replay = await buildSourceRoster(primary, { source: sourceAddress, chainId: 31337n, deploymentTx,
    confirmations: 1, headerReader: headers, maxBlocks: 1000, maxReceipts: 1000, logChunk: 100 });
  const replayMs = performance.now() - started;
  if (replay.tree.entries.length !== count) throw new Error('local source replay entry count mismatch');
  const publication = await (await source.publishEpoch(1, replay.tree.root, 1,
    replay.manifest.cutoffTimestamp + 86400, replay.manifest.cutoffTimestamp, ethers.id(`snapshot-${count}`))).wait();
  if (!publication || publication.status !== 1) throw new Error('local synthetic root publication failed');
  return { trust: 'two-reader-interface-over-one-local-anvil-not-independent-infrastructure', batchSize: 100,
    issuanceTransactions, issuanceEvents: count, issuanceGasActual: issuanceGas.toString(),
    rootPublicationTransactions: 1, rootPublicationGasActual: publication.gasUsed.toString(),
    replayMs, replayManifest: { blocks: replay.manifest.blocks, receipts: replay.manifest.receipts, sourceLogs: replay.manifest.sourceLogs },
    rpcCalls: { ...calls, total: Object.values(calls).reduce((sum, value) => sum + value, 0) } };
}
try {
  if (args.includes('--gas') || args.includes('--source-replay')) {
    const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
    anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' });
    const request = new ethers.FetchRequest(`http://127.0.0.1:${port}`); request.timeout = 1000;
    provider = new ethers.JsonRpcProvider(request, 31337, { cacheTimeout: -1, batchMaxCount: 1 });
    for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch { if (i >= 30) throw Error('local cost Anvil not ready'); await delay(100); } }
    const artifact = JSON.parse(readFileSync(new URL('../out/RosterCostFixture.sol/RosterCostFixture.json', import.meta.url), 'utf8'));
    signer = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk').privateKey, provider);
    if (args.includes('--gas')) {
      const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer).deploy();
      await deployed.waitForDeployment(); cost = new ethers.Contract(await deployed.getAddress(), artifact.abi, signer);
    }
  }
  const cases = [];
  for (const count of counts) {
    const startHeap = process.memoryUsage().heapUsed;
    const start = performance.now(); const { record, scope } = bundleFixture(count);
    const built = performance.now(); const out = exportRosterBundle(record, scope);
    const exported = performance.now(); const loaded = loadRosterBundle(out.bytes, out.contentHash);
    const reconstructed = performance.now();
    const durations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const then = performance.now(); loaded.proof(record.entries[i % count].subject); durations.push(performance.now() - then);
    }
    durations.sort((a, b) => a - b);
    const present = loaded.proof(record.entries[Math.floor(count / 2)].subject), absent = loaded.proof(ethers.toBeHex(count + 1, 20));
    if (present.kind !== 'inclusion' || absent.kind !== 'non-inclusion') throw Error('incorrect synthetic membership');
    let localGas: unknown = { status: 'not-run' };
    if (cost) {
      const entry = { subject: present.subject, ...present.mark };
      if (!(await cost.inclusion(present.root, rosterLeaf(entry), present.proof)) || !(await cost.absence(absent.root, subjectKey(absent.subject), absent.proof))) throw Error('compiled Solidity rejects generated proof');
      const cacheReceipt = await (await cost.cache(present.subject, present.root, rosterLeaf(entry), present.proof)).wait();
      if (!cacheReceipt || cacheReceipt.status !== 1) throw new Error('local storage proof harness rejected generated proof');
      localGas = { status: 'local-anvil-actual-transaction-and-eth-estimateGas', inclusion: String(await cost.inclusion.estimateGas(present.root, rosterLeaf(entry), present.proof)),
        nonInclusion: String(await cost.absence.estimateGas(absent.root, subjectKey(absent.subject), absent.proof)),
        storageWitnessActual: String(cacheReceipt.gasUsed),
        scope: 'transaction-intrinsic plus proof/storage harness; not Registry policy/ASC/native-verifier or CC3 fee' };
    }
    const http = args.includes('--http') ? await httpBenchmark(loaded, out.contentHash, present.subject) : { status: 'not-run' };
    const sourceReplay = args.includes('--source-replay') ? await sourceReplayBenchmark(count) : { status: 'not-run' };
    cases.push({ count, sourceGenerationAndRootMs: built - start, exportAndRootRecheckMs: exported - built,
      replicaReconstructionMs: reconstructed - exported, querySamples: 100, inclusionQueryMs: { p50: durations[49], p95: durations[94], p99: durations[98] },
      bundleBytes: out.bytes.length, contentHash: out.contentHash, proofDepth: present.proof.siblings.length,
      inclusionResponseBytes: Buffer.byteLength(JSON.stringify(present)), nonInclusionResponseBytes: Buffer.byteLength(JSON.stringify(absent)),
      witnessCalldataBytes: ethers.dataLength(present.transaction.data), heapDeltaBytes: process.memoryUsage().heapUsed - startHeap,
      processPeakRssBytesCumulative: process.resourceUsage().maxRSS * 1024, http, sourceReplay, localGas });
  }
  const report = { version: 1, generatedAt: new Date().toISOString(), evidence: 'synthetic-local-bundle-not-production-SLA',
    node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cases,
    limitations: ['single process/run; heap delta includes GC and cumulative RSS includes earlier cases',
      'localhost HTTP is a bounded one-process run, not production ingress, sustained concurrency, abuse or fault load',
      'source replay uses two reader interfaces over one local Anvil, synthetic batched events and no archive-network latency',
      'no Ethereum/CC3 fee prices or native proof/ASC relay gas measured; storage harness is not Registry gas',
      'root publication does not make per-person source issuance or witness writes constant',
      'configured file replicas only survive outages if staged durably before failure; no independently hosted replication/SLA claimed'] };
  if (args.includes('--write')) {
    const directory = join('artifacts', 'roster-benchmark', report.generatedAt.replace(/[:.]/g, '-'));
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`wrote ${directory}/report.json`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  provider?.destroy();
  if (anvil && anvil.exitCode === null) { anvil.kill('SIGTERM'); await new Promise(resolve => anvil!.once('exit', resolve)); }
}
