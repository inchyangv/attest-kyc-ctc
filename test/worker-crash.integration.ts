import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { packAttrs } from '../pipeline/attrs.js';
import { computeQueryId } from '../worker/proof.js';
import { Store } from '../worker/store.js';

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
const key = (n: number) => ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${n}`).privateKey;

test('historical denial survives reverse delivery and worker SIGKILL around broadcast on a fresh ASC', { timeout: 40000 }, async t => {
  const cleanups: (() => void | Promise<void>)[] = [];
  const cleanup = (fn: () => void | Promise<void>) => { cleanups.push(fn); };
  t.after(async () => {
    const errors: unknown[] = [];
    for (const fn of cleanups.reverse()) { try { await fn(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'isolated crash test cleanup failed');
  });
  async function freePort() {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve())); return port;
  }
  async function chain(chainId: number) {
    const port = await freePort(), url = `http://127.0.0.1:${port}`;
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--silent'], { stdio: 'ignore' });
    const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
    cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit; });
    const provider = issuanceProvider(url); cleanup(() => provider.destroy());
    for (let n = 0; ; n++) {
      try { await provider.getBlockNumber(); break; }
      catch { if (n >= 30 || child.exitCode !== null) throw new Error('isolated Anvil unavailable'); await delay(100); }
    }
    return { url, provider };
  }
  const sourceChain = await chain(11155111), hubChain = await chain(102031);
  const sourceOwner = new ethers.Wallet(key(0), sourceChain.provider), hubOwner = new ethers.Wallet(key(0), hubChain.provider);
  const issuer = new ethers.Wallet(key(1), sourceChain.provider);
  async function deploy(name: string, wallet: ethers.Wallet, args: unknown[] = [], library?: string) {
    const a = artifact(name); let bytes = a.bytecode.object as string;
    for (const libraries of Object.values(a.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
      for (const [name, offsets] of Object.entries(libraries)) {
        assert.equal(name, 'EvmV1Decoder'); assert.ok(library);
        for (const offset of offsets) { assert.equal(offset.length, 20); const at = 2 + offset.start * 2;
          bytes = bytes.slice(0, at) + library.slice(2) + bytes.slice(at + 40);
        }
      }
    }
    const deployed = await new ethers.ContractFactory(a.abi, bytes, wallet).deploy(...args); await deployed.waitForDeployment();
    return new ethers.Contract(await deployed.getAddress(), a.abi, wallet);
  }
  const source = await deploy('ComplianceSource', sourceOwner, [sourceOwner.address]);
  await (await source.setIssuer(issuer.address, true)).wait();
  const decoder = await deploy('EvmV1Decoder', hubOwner);
  await hubChain.provider.send('anvil_setCode', ['0x0000000000000000000000000000000000000FD2', artifact('MockBlockProver').deployedBytecode.object]);
  const asc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();
  const root = mkdtempSync(join(tmpdir(), 'proofmark-worker-crash-')); cleanup(() => rmSync(root, { recursive: true, force: true }));
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encodeReceipt = (receipt: ethers.TransactionReceipt) => {
    const payload = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
      [receipt.status, receipt.gasUsed, receipt.logs.map((log: ethers.Log) => [log.address, [...log.topics], log.data]), '0x']);
    return coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', payload]]);
  };

  for (const acceptedBeforeCrash of [false, true]) {
    const subject = new ethers.Wallet(key(acceptedBeforeCrash ? 8 : 7)).address;
    const receipt = await (await source.connect(issuer).getFunction('deny')(subject, 7, 1)).wait(); assert.ok(receipt);
    assert.equal(receipt.index, 0);

    // Materialise a later source issuance first. The full migration scan discovers both source
    // records: the already-processed issuance takes the depth-bound skip path, while the older
    // denial must still become monotonic state. This is T-01's reverse-delivery counterexample.
    const deniedBlock = await sourceChain.provider.getBlock(receipt.blockNumber); assert.ok(deniedBlock);
    const attrs = packAttrs({ kind: 1, assurance: 3, regime: 1, jurisdiction: 410, methods: 1,
      issuedAt: deniedBlock.timestamp, expiry: deniedBlock.timestamp + 86400, epoch: 1 });
    const issueReceipt = await (await source.connect(issuer).getFunction('issue')(
      subject, attrs, ethers.id(`claims-${subject}`), ethers.id(`evidence-${subject}`),
    )).wait(); assert.ok(issueReceipt);
    assert.ok(issueReceipt.blockNumber > receipt.blockNumber);
    assert.equal(issueReceipt.index, 0);
    await (await asc.execute(0, 1, issueReceipt.blockNumber, encodeReceipt(issueReceipt),
      ethers.ZeroHash, [], ethers.ZeroHash, [])).wait();
    assert.equal(Number((await asc.getMark(subject)).status), 1);
    assert.equal(await asc.tombstone(subject), false);
    assert.equal(Number(await asc.lastAppliedHeight(subject)), issueReceipt.blockNumber);
    await sourceChain.provider.send('anvil_mine', ['0x50']);

    const proofFor = (sourceReceipt: ethers.TransactionReceipt) => ({ chainKey: 1, headerNumber: sourceReceipt.blockNumber,
      txBytes: encodeReceipt(sourceReceipt), merkleProof: { root: ethers.ZeroHash, siblings: [] },
      continuityProof: { lowerEndpointDigest: ethers.ZeroHash, roots: [] } });
    const proof = proofFor(receipt), issueProof = proofFor(issueReceipt);
    const wallet = new ethers.Wallet(key(acceptedBeforeCrash ? 4 : 3), hubChain.provider);
    const dir = join(root, acceptedBeforeCrash ? 'accepted' : 'not-forwarded'), path = join(dir, 'worker.json');
    const workerScope = { sourceChainId: 11155111, hubChainId: 102031, chainKey: 1,
      source: (await source.getAddress()).toLowerCase(), asc: (await asc.getAddress()).toLowerCase(), signer: wallet.address.toLowerCase(),
      startBlock: receipt.blockNumber };
    const initialState = new Store(path); initialState.bindScope(workerScope); initialState.initializeHubSigner(0);
    let attempts = 0, attestationCalls = 0;
    const proofCalls = { denial: 0, issue: 0 };
    const rawRequests: string[] = []; let intercepted!: () => void, release!: () => void;
    const reached = new Promise<void>(resolve => intercepted = resolve), gate = new Promise<void>(resolve => release = resolve);
    const serviceErrors: unknown[] = [];
    const server = createServer(async (req, res) => {
      try {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/v1/attested-height/1') { attestationCalls++; res.end(JSON.stringify({ attestedHeight: issueReceipt.blockNumber })); return; }
        if (req.url === `/api/v1/proof-by-tx/1/${receipt.hash}`) { proofCalls.denial++; res.end(JSON.stringify(proof)); return; }
        if (req.url === `/api/v1/proof-by-tx/1/${issueReceipt.hash}`) { proofCalls.issue++; res.end(JSON.stringify(issueProof)); return; }
        assert.equal(req.url, '/hub'); let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        const answer = async (call: { id: number; method: string; params: unknown[] }) => {
          if (call.method === 'eth_sendRawTransaction') {
            attempts++; const raw = call.params[0] as string; rawRequests.push(raw);
            const saved = new Store(path).relay!; assert.equal(saved.raw, raw, 'worker durably saved its signature before HTTP broadcast');
            assert.equal(saved.hash, ethers.keccak256(raw)); assert.equal(saved.sourceTxHash, receipt.hash);
            if (attempts === 1) {
              if (acceptedBeforeCrash) await hubChain.provider.send(call.method, call.params);
              intercepted(); await gate;
              return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'SYNTHETIC_ACK_WITHHELD' } };
            }
          }
          try { return { jsonrpc: '2.0', id: call.id, result: await hubChain.provider.send(call.method, call.params) }; }
          catch { return { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'SYNTHETIC_RPC_FAILURE' } }; }
        };
        res.end(JSON.stringify(Array.isArray(input) ? await Promise.all(input.map(answer)) : await answer(input)));
      } catch (error) { serviceErrors.push(error); res.writeHead(500); res.end('{"error":"FIXTURE_FAILED"}'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const serviceUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanup(() => new Promise<void>(resolve => { release(); server.close(() => resolve()); server.closeAllConnections(); }));
    const env = { PATH: process.env.PATH, SOURCE_CHAIN_RPC_URL: sourceChain.url, CREDITCOIN_RPC_URL: `${serviceUrl}/hub`,
      PROOF_BUILDER_URL: serviceUrl, WORKER_PRIVATE_KEY: wallet.privateKey, WORKER_SIGNER_ADDRESS: wallet.address,
      SOURCE_CONTRACT_ADDRESS: await source.getAddress(),
      ASC_CONTRACT_ADDRESS: await asc.getAddress(), SOURCE_CHAIN_KEY: '1', WORKER_START_BLOCK: String(receipt.blockNumber),
      WORKER_CONFIRMATIONS: '1', WORKER_HUB_CONFIRMATIONS: '1', WORKER_POLL_MS: '50', WORKER_CONCURRENCY: '2',
      WORKER_STATE_PATH: path, WORKER_HEALTH_PORT: '', WORKER_HEALTH_MAX_SCAN_AGE_MS: '' };
    function worker(statePath = path) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'worker/index.ts'], { cwd: process.cwd(), env: { ...env, WORKER_STATE_PATH: statePath }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => output = (output + chunk).slice(-6000)); child.stderr.on('data', chunk => output = (output + chunk).slice(-6000));
      const exit = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      cleanup(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
      return { child, exit, output: () => output };
    }
    const first = worker();
    await Promise.race([reached, first.exit.then(() => { throw new Error(`worker exited before broadcast: ${first.output()}`); })]);
    const original = new Store(path).relay!; const bytes = readFileSync(path);
    assert.equal(original.nonce, 0); assert.equal(ethers.Transaction.from(original.raw).from, wallet.address);
    assert.equal(await asc.tombstone(subject), acceptedBeforeCrash);
    assert.equal(await hubChain.provider.getTransactionCount(wallet.address), acceptedBeforeCrash ? 1 : 0);
    const initialReceipt = await hubChain.provider.getTransactionReceipt(original.hash);
    if (acceptedBeforeCrash) { assert.equal(initialReceipt?.status, 1); assert.equal(initialReceipt?.hash, original.hash); }
    else assert.equal(initialReceipt, null);
    first.child.kill('SIGKILL'); assert.deepEqual(await first.exit, { code: null, signal: 'SIGKILL' });
    release();
    const locks = [`${path}.lock`, join(dir, `relay-102031-${wallet.address.toLowerCase()}.lock`)];
    for (const lock of locks) assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, first.child.pid);
    assert.deepEqual(readFileSync(path), bytes, 'abnormal exit did not clear the submitted envelope');
    const refused = worker(); assert.equal((await refused.exit).code, 1);
    assert.match(refused.output(), /WORKER_LEASE_UNAVAILABLE/); assert.deepEqual(readFileSync(path), bytes);
    // Isolated test-only recovery: exact child exit was awaited above; preserve its two lock
    // files as evidence instead of clearing arbitrary production leases or trusting a PID probe.
    for (const lock of locks) renameSync(lock, `${lock}.crashed-${first.child.pid}`);
    const restarted = worker();
    for (let n = 0; ; n++) {
      assert.equal(restarted.child.exitCode, null, restarted.output());
      if (new Store(path).get(receipt.hash)?.state === 'done') break;
      if (n >= 150) throw new Error(`restart did not reconcile: ${restarted.output()}`); await delay(30);
    }
    const recovered = new Store(path); assert.equal(recovered.relay, undefined);
    assert.equal(recovered.get(receipt.hash)?.ascTxHash, original.hash);
    assert.equal(recovered.get(receipt.hash)?.relayHistory?.length, 1);
    assert.equal(recovered.get(receipt.hash)?.relayHistory?.[0].hash, original.hash);
    assert.equal(await asc.processedQueries(computeQueryId(1, receipt.blockNumber, 0)), true);
    assert.equal(await asc.tombstone(subject), true);
    assert.equal(await asc.permanentDenial(subject), true);
    assert.equal(Number((await asc.getMark(subject)).status), 3);
    assert.equal(Number(await asc.lastAppliedHeight(subject)), issueReceipt.blockNumber, 'stale denial must not rewind the ordinary cursor');
    assert.equal(await hubChain.provider.getTransactionCount(wallet.address), 1);
    assert.ok(attestationCalls >= 2);
    assert.equal(proofCalls.denial, 1, 'signed denial restart must not fetch a new proof');
    assert.ok(proofCalls.issue >= 1, 'migration scan must examine the already-applied issuance');
    const issueProofCallsBeforeFreshScan = proofCalls.issue;
    assert.equal(attempts, acceptedBeforeCrash ? 1 : 2);
    assert.ok(rawRequests.every(raw => raw === original.raw)); assert.deepEqual(serviceErrors, []);
    restarted.child.kill('SIGTERM'); assert.deepEqual(await restarted.exit, { code: 0, signal: null });
    for (const lock of locks) { assert.equal(existsSync(lock), false); assert.equal(existsSync(`${lock}.crashed-${first.child.pid}`), true); }

    // A separate new state file sees the already-applied source query. Exercise the actual
    // worker's single depth/hash-bound skip path, not just RelaySender in isolation.
    const skipPath = join(dir, 'already-applied.json'), skipState = new Store(skipPath);
    skipState.bindScope(workerScope); skipState.initializeHubSigner(1);
    const already = worker(skipPath);
    for (let n = 0; ; n++) {
      assert.equal(already.child.exitCode, null, already.output());
      if (existsSync(skipPath)) {
        const scan = new Store(skipPath);
        if (scan.get(receipt.hash)?.state === 'skipped' && scan.get(issueReceipt.hash)?.state === 'skipped') break;
      }
      if (n >= 150) throw new Error(`new worker did not safely skip: ${already.output()}`); await delay(30);
    }
    const skip = new Store(skipPath).get(receipt.hash)!.skipObservation!;
    assert.ok(skip); assert.ok(skip.confirmations >= 1);
    assert.equal((await hubChain.provider.getBlock(skip.blockNumber))?.hash, skip.blockHash);
    assert.equal(await hubChain.provider.getTransactionCount(wallet.address), 1);
    assert.equal(attempts, acceptedBeforeCrash ? 1 : 2);
    assert.equal(proofCalls.denial, 2);
    assert.ok(proofCalls.issue > issueProofCallsBeforeFreshScan);
    already.child.kill('SIGTERM'); assert.deepEqual(await already.exit, { code: 0, signal: null });
  }
});
