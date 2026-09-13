import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { createHash, createDecipheriv } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { packAttrs } from '../pipeline/attrs.js';
import { EpochPublicationJournal } from '../pipeline/epoch-publication-journal.js';
import { refreshSnapshot } from '../aml/snapshot-store.js';
import { currentGeneration } from '../aml/loader.js';
import { SOURCES } from '../aml/provenance.js';
import { Store } from '../worker/store.js';
import { computeQueryId } from '../worker/proof.js';
import { loadRosterBundle } from '../pipeline/roster-bundle.js';

test('actual fresh publisher CLI and worker: isolated lists, source lost ACK, durable relay, mock-native carry and policy check', { timeout: 60000 }, async t => {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => { const errors: unknown[] = []; for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { errors.push(e); } } if (errors.length) throw new AggregateError(errors); });
  const root = mkdtempSync(join(tmpdir(), 'proofmark-fresh-epoch-cli-')); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  // Execute an exact copy of the current CLI with its own REPO/data/raw. No production option
  // bypasses freshness and no fixture bytes/timestamps touch the workspace's actual AML data.
  for (const dir of ['script', 'deployments']) mkdirSync(join(root, dir));
  copyFileSync(resolve('script/publish-epoch.ts'), join(root, 'script/publish-epoch.ts'));
  copyFileSync(resolve('deployments/cc3-testnet.json'), join(root, 'deployments/cc3-testnet.json'));
  for (const dir of ['pipeline', 'aml', 'node_modules']) symlinkSync(resolve(dir), join(root, dir), 'dir');
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  const rawDir = join(root, 'data/raw'), now = Date.now(), listCheckedAt = now - 23 * 3_600_000;
  const provenance = await refreshSnapshot(rawDir, async id => ({
    bytes: Buffer.from(id === 'OFAC_SDN' ? '<sdnList><sdnEntry><uid>1</uid><lastName>FICTIONAL ONLY</lastName><sdnType>Individual</sdnType></sdnEntry></sdnList>'
      : id === 'UN_CONSOLIDATED' ? '<CONSOLIDATED_LIST><INDIVIDUAL><DATAID>2</DATAID><FIRST_NAME>FICTIONAL ONLY</FIRST_NAME></INDIVIDUAL></CONSOLIDATED_LIST>'
      : '<export><sanctionEntity logicalId="3"><nameAlias wholeName="FICTIONAL ONLY"/><subjectType code="person"/></sanctionEntity></export>'),
    fetchedAt: new Date(listCheckedAt).toISOString(), effectiveUrl: SOURCES[id].url, httpLastModified: null,
  }), () => listCheckedAt); // Synthetic downloader metadata, not an actual official-source GET.
  async function chain(id: number) {
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(id), '--timestamp', String(Math.floor(now / 1000) - 600), '--silent'], { stdio: 'ignore' });
    const exit = new Promise<void>(r => child.once('exit', () => r()));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exit; });
    const url = `http://127.0.0.1:${port}`, provider = issuanceProvider(url); cleanup.push(() => provider.destroy());
    for (let i = 0; ; i++) { try { await provider.getBlockNumber(); break; } catch { if (i >= 30 || child.exitCode !== null) throw Error('isolated Anvil unavailable'); await delay(100); } }
    return { url, provider };
  }
  const src = await chain(11155111), hub = await chain(102031);
  const key = (i: number) => ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${i}`).privateKey;
  const owner = new ethers.Wallet(key(0), src.provider), publisher = new ethers.Wallet(key(1), src.provider), hubOwner = new ethers.Wallet(key(0), hub.provider);
  const artifact = (name: string) => JSON.parse(readFileSync(resolve(`out/${name}.sol/${name}.json`), 'utf8'));
  async function deploy(name: string, wallet: ethers.Wallet, args: unknown[], library?: string) {
    const a = artifact(name); let bytes = a.bytecode.object as string;
    for (const libs of Object.values(a.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) for (const [name, offsets] of Object.entries(libs)) {
      assert.equal(name, 'EvmV1Decoder'); assert.ok(library);
      for (const offset of offsets) { assert.equal(offset.length, 20); const start = 2 + offset.start * 2; bytes = bytes.slice(0, start) + library.slice(2) + bytes.slice(start + 40); }
    }
    const c = await new ethers.ContractFactory(a.abi, bytes, wallet).deploy(...args); await c.waitForDeployment();
    return { contract: new ethers.Contract(await c.getAddress(), a.abi, wallet), tx: c.deploymentTransaction()!.hash };
  }
  const { contract: source, tx: deploymentTx } = await deploy('ComplianceSource', owner, [owner.address]);
  await (await source.setIssuer(publisher.address, true)).wait(); await (await source.setEpochPublisher(publisher.address, true)).wait();
  const demo = '0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2', issueTime = (await src.provider.getBlock('latest'))!.timestamp;
  // Owner-driven fixture issuance uses the dedicated publisher as issuer; publication nonce
  // assertions account for this initial source issuance separately.
  await (await source.connect(publisher).getFunction('issue')(demo, packAttrs({ kind: 1, assurance: 3, regime: 2,
    jurisdiction: 410, methods: 65572, issuedAt: issueTime, expiry: issueTime + 86400, epoch: 0 }), ethers.id('fixture-claims'), ethers.id('fixture-evidence'))).wait();
  await src.provider.send('anvil_mine', ['0x50']);
  const { contract: decoder } = await deploy('EvmV1Decoder', hubOwner, []);
  const { contract: asc } = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();
  const { contract: registry } = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);
  for (const id of [1, 2]) { await (await registry.registerPolicy([65572, 2, id === 1 ? 2592000 : 604800, id, 410, publisher.address, true, false])).wait(); await (await registry.freezePolicy(id)).wait(); }
  await hub.provider.send('anvil_setCode', ['0x0000000000000000000000000000000000000FD2', artifact('MockBlockProver').deployedBytecode.object]);
  const path = join(root, 'publisher.enc'), secret = 'synthetic-fresh-cli-journal-key-at-least-32-characters';
  const scope = { chainId: 11155111, source: (await source.getAddress()).toLowerCase(), publisher: publisher.address.toLowerCase() };
  let sends = 0, acceptedHash: string | undefined, signedRaw: string | undefined;
  const proxyErrors: unknown[] = [];
  const proxy = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body); assert.equal(Array.isArray(call), false);
      if (call.method === 'eth_sendRawTransaction') {
        sends++; signedRaw = call.params[0];
        const envelope = JSON.parse(readFileSync(path, 'utf8'));
        const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update('proofmark-epoch-key-v1\0').update(secret).digest(), Buffer.from(envelope.iv, 'base64'));
        decipher.setAAD(Buffer.from(`proofmark-epoch-publication-v1\0${JSON.stringify(scope)}`)); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
        const saved = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
        assert.equal(saved.entries.length, sends); assert.equal(saved.entries.at(-1).transaction.raw, signedRaw);
        assert.equal(saved.entries.at(-1).transaction.nonce, sends); assert.equal(saved.entries.at(-1).confirmation, undefined);
        acceptedHash = await src.provider.send(call.method, call.params);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'SYNTHETIC_LOST_ACK_AFTER_ACCEPTANCE' } })); return;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: await src.provider.send(call.method, call.params) }));
    } catch (e) { proxyErrors.push(e); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r)); cleanup.push(() => new Promise<void>(r => { proxy.close(() => r()); proxy.closeAllConnections(); }));
  const env = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: join(root, 'absent.env'),
    SOURCE_CHAIN_RPC_URL: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, SOURCE_HEADER_RPC_URL: src.url,
    CREDITCOIN_RPC_URL: hub.url,
    SOURCE_CONTRACT_ADDRESS: scope.source, ASC_CONTRACT_ADDRESS: await asc.getAddress(), REGISTRY_CONTRACT_ADDRESS: await registry.getAddress(),
    SOURCE_DEPLOYMENT_TX: deploymentTx, SOURCE_CONFIRMATIONS: '1', EPOCH_POLL_SECONDS: '1', EPOCH_TIMEOUT_MINUTES: '1', EPOCH_SOURCE_WAIT_SECONDS: '3', EPOCH_HUB_CONFIRMATIONS: '1',
    EPOCH_PUBLISHER_PRIVATE_KEY: publisher.privateKey, EPOCH_PUBLISHER_ADDRESS: publisher.address,
    EPOCH_PUBLICATION_JOURNAL_PATH: path, EPOCH_PUBLICATION_JOURNAL_KEY: secret,
    EPOCH_BUNDLE_DISCLOSURE_ACK: 'wallet-linkable-roster-approved',
    EPOCH_BUNDLE_REPLICA_DIRS: JSON.stringify([join(root, 'roster-replica-a'), join(root, 'roster-replica-b')]),
    SOURCE_SNAPSHOT_CHECKPOINT_PATH: join(root, 'source-checkpoint.enc'),
    SOURCE_SNAPSHOT_CHECKPOINT_KEY: 'synthetic-source-checkpoint-secret-at-least-32-characters',
    EPOCH_RECORD_DIR: join(root, 'records'), DEMO_EXPECTED_ISSUER: publisher.address,
    DEMO_SOURCE_CODEHASH: ethers.keccak256(await src.provider.getCode(scope.source)),
    DEMO_ASC_CODEHASH: ethers.keccak256(await hub.provider.getCode(await asc.getAddress())),
    DEMO_REGISTRY_CODEHASH: ethers.keccak256(await hub.provider.getCode(await registry.getAddress())) };
  function publish(overrides: NodeJS.ProcessEnv = {}, mode = '--publish') {
    const child = spawn(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', mode], { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output = (output + b).slice(-30000)); child.stderr.on('data', b => output = (output + b).slice(-30000));
    const exit = new Promise<number | null>((r, reject) => { child.once('error', reject); child.once('exit', r); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 25000); void exit.finally(() => clearTimeout(timeout)).catch(() => {});
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
    return { child, exit, output: () => output };
  }
  const beforePublication = await src.provider.send('evm_snapshot', []);
  const refusedWithoutReplicas = publish({ EPOCH_BUNDLE_DISCLOSURE_ACK: undefined, EPOCH_BUNDLE_REPLICA_DIRS: undefined });
  assert.equal(await refusedWithoutReplicas.exit, 1, refusedWithoutReplicas.output());
  assert.match(refusedWithoutReplicas.output(), /PUBLICATION_ROSTER_DISCLOSURE_APPROVAL_REQUIRED/);
  assert.equal(await source.lastEpoch(), 0n, 'missing availability approval must fail before source publication');
  assert.equal(await src.provider.getTransactionCount(publisher.address), 1, 'availability failure must not consume another signer nonce');
  const running = publish();
  for (let i = 0; !acceptedHash; i++) { assert.equal(running.child.exitCode, null, running.output()); if (i > 200) throw Error(`CLI never published: ${running.output()}`); await delay(50); }
  const receipt = (await src.provider.getTransactionReceipt(acceptedHash!))!;
  const timestamp = (await src.provider.getBlock(receipt.blockNumber))!.timestamp;
  if ((await hub.provider.getBlock('latest'))!.timestamp <= timestamp) await hub.provider.send('evm_setNextBlockTimestamp', [timestamp + 1]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const payload = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'], [receipt.status, receipt.gasUsed, receipt.logs.map(l => [l.address, [...l.topics], l.data]), '0x']);
  assert.equal(receipt.index, 0, 'empty sibling fixture represents source transaction index zero');
  const proof = { chainKey: 1, headerNumber: receipt.blockNumber, txBytes: coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', payload]]),
    merkleProof: { root: ethers.ZeroHash, siblings: [] }, continuityProof: { lowerEndpointDigest: ethers.ZeroHash, roots: [] } };
  let attestationCalls = 0, proofCalls = 0;
  const serviceErrors: unknown[] = [];
  const service = createServer((req, res) => {
    try {
      assert.equal(req.method, 'GET'); res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v1/attested-height/1') { attestationCalls++; res.end(JSON.stringify({ attestedHeight: receipt.blockNumber })); }
      else { assert.equal(req.url, `/api/v1/proof-by-tx/1/${receipt.hash}`); proofCalls++; res.end(JSON.stringify(proof)); }
    } catch (error) { serviceErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(r => service.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => { service.close(() => r()); service.closeAllConnections(); }));
  await src.provider.send('anvil_mine', ['0x50']); // Actual worker requires the epoch below Anvil's finalized head.
  const workerWallet = new ethers.Wallet(key(2), hub.provider), workerPath = join(root, 'worker/state.json');
  const initialWorkerState = new Store(workerPath); initialWorkerState.bindScope({ sourceChainId: 11155111, hubChainId: 102031,
    chainKey: 1, source: scope.source, asc: env.ASC_CONTRACT_ADDRESS.toLowerCase(), signer: workerWallet.address.toLowerCase(),
    startBlock: receipt.blockNumber }); initialWorkerState.initializeHubSigner(0);
  function worker() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'worker/index.ts'], { cwd: resolve('.'),
      env: { PATH: process.env.PATH, DOTENV_CONFIG_PATH: join(root, 'absent.env'), SOURCE_CHAIN_RPC_URL: src.url, CREDITCOIN_RPC_URL: hub.url,
        PROOF_BUILDER_URL: `http://127.0.0.1:${(service.address() as { port: number }).port}`, WORKER_PRIVATE_KEY: workerWallet.privateKey,
        WORKER_SIGNER_ADDRESS: workerWallet.address,
        SOURCE_CONTRACT_ADDRESS: scope.source, ASC_CONTRACT_ADDRESS: env.ASC_CONTRACT_ADDRESS, SOURCE_CHAIN_KEY: '1',
        WORKER_STATE_PATH: workerPath, WORKER_START_BLOCK: String(receipt.blockNumber), WORKER_CONFIRMATIONS: '1',
        WORKER_HUB_CONFIRMATIONS: '1', WORKER_POLL_MS: '50', WORKER_CONCURRENCY: '2', WORKER_HEALTH_PORT: '', WORKER_HEALTH_MAX_SCAN_AGE_MS: '' },
      stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output = (output + b).slice(-12000)); child.stderr.on('data', b => output = (output + b).slice(-12000));
    const exit = new Promise<{ code: number | null; signal: string | null }>((r, reject) => { child.once('error', reject); child.once('exit', (code, signal) => r({ code, signal })); });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; });
    return { child, exit, output: () => output };
  }
  assert.equal(await source.lastEpoch(), 1n); assert.equal(await asc.latestEpoch(), 0n, 'source acceptance alone does not materialize the hub');
  assert.equal(running.child.exitCode, null, 'publisher must still wait for actual hub carry');
  const relayer = worker();
  for (let i = 0; ; i++) {
    assert.equal(relayer.child.exitCode, null, relayer.output());
    if (new Store(workerPath).get(receipt.hash)?.state === 'done') break;
    if (i >= 200) throw Error(`worker did not relay epoch: ${relayer.output()}`); await delay(50);
  }
  const job = new Store(workerPath).get(receipt.hash)!;
  assert.equal(job.action, 3); assert.equal(job.logCount, 1, 'one epoch event triggers one job; authorization is not a separate job');
  assert.deepEqual(receipt.logs.filter(l => l.address.toLowerCase() === scope.source).map(l => source.interface.parseLog(l)!.name),
    ['RosterIssuerAuthorized', 'RosterEpochPublished'], 'the full proved receipt retains both authorization and epoch events');
  assert.equal(job.queryId, computeQueryId(1, receipt.blockNumber, receipt.index));
  assert.equal(job.relayHistory?.length, 1); assert.equal(job.relayHistory![0].status, 'success');
  assert.equal(job.ascTxHash, job.relayHistory![0].hash);
  assert.equal((await hub.provider.getTransactionReceipt(job.ascTxHash!))!.status, 1);
  assert.equal(await asc.processedQueries(job.queryId!), true);
  assert.equal(await hub.provider.getTransactionCount(workerWallet.address), 1);
  assert.equal(attestationCalls, 1); assert.equal(proofCalls, 1);
  assert.equal(relayer.output().includes(workerWallet.privateKey), false);
  relayer.child.kill('SIGTERM'); assert.deepEqual(await relayer.exit, { code: 0, signal: null });
  for (const lock of [`${workerPath}.lock`, join(root, `worker/relay-102031-${workerWallet.address.toLowerCase()}.lock`)]) assert.equal(existsSync(lock), false);
  assert.equal(await running.exit, 0, running.output()); assert.match(running.output(), /all verdicts match expectation/);
  assert.equal(sends, 1); assert.equal(await source.lastEpoch(), 1n); assert.equal(await asc.latestEpoch(), 1n);
  assert.equal(await src.provider.getTransactionCount(publisher.address), 2);
  const files = readdirSync(env.EPOCH_RECORD_DIR).filter(f => f.endsWith('.json')); assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(env.EPOCH_RECORD_DIR, files[0]), 'utf8'));
  assert.equal(record.publishEpochTx, acceptedHash); assert.equal(record.snapshotId, `0x${provenance.snapshotId}`);
  assert.equal(record.validUntil, Math.floor(listCheckedAt / 1000) + 86400,
    'the oldest list check, not a fresh source cutoff, caps the epoch lifetime');
  assert.ok(record.validUntil < record.sourceCutoff + 86400,
    'a 23-hour-old snapshot cannot be repackaged into another full-day epoch');
  assert.deepEqual(record.checks.map((v: { actual: boolean }) => v.actual), [true, false, true]);
  assert.ok(record.cc3AcceptedAt && record.hubObservation && record.policyObservation && record.runtimeObservation);
  assert.equal(record.hubCarry.transactionHash, job.ascTxHash); assert.equal(record.hubCarry.queryId, job.queryId);
  assert.equal(record.hubCarry.sourceBlock, receipt.blockNumber); assert.equal(record.hubCarry.sourceTxIndex, receipt.index);
  assert.equal(record.sourcePublicationObservation.transactionHash, receipt.hash);
  assert.equal(record.sourcePublicationObservation.blockHash, receipt.blockHash);
  assert.equal(record.sourcePublicationObservation.status, 1);
  assert.equal(record.proofAvailability.replicaCount, 2);
  for (const replica of JSON.parse(env.EPOCH_BUNDLE_REPLICA_DIRS)) {
    const names = readdirSync(replica);
    assert.equal(names.filter((name: string) => name.endsWith('.seed.json')).length, 1);
    const bundleName = `${record.proofAvailability.contentHash}.json`;
    assert.ok(names.includes(bundleName));
    assert.equal(loadRosterBundle(readFileSync(join(replica, bundleName)), record.proofAvailability.contentHash).proof(demo).kind, 'inclusion');
  }
  assert.equal(running.output().includes(signedRaw!), false); assert.equal(running.output().includes(publisher.privateKey), false);
  const journal = new EpochPublicationJournal(path, secret, scope);
  const originalEntry = journal.snapshot()[0];
  try {
    assert.equal(originalEntry.transaction!.raw, signedRaw); assert.equal(originalEntry.confirmation!.status, 1);
    assert.equal(originalEntry.intent.availability?.seedHash, record.proofAvailability.seedHash);
    assert.equal(record.proofAvailability.prepublicationBound, true);
  } finally { journal.close(); }
  const readonlyEnv = { EPOCH_PUBLISHER_PRIVATE_KEY: undefined, EPOCH_PUBLISHER_ADDRESS: publisher.address, EPOCH_HUB_FROM_BLOCK: '0' };
  const journalBytes = readFileSync(path);
  const verified = publish(readonlyEnv, '--check-publication');
  assert.equal(await verified.exit, 0, verified.output()); assert.match(verified.output(), /no transaction signed or sent, journal bytes unchanged/);
  assert.deepEqual(readFileSync(path), journalBytes); assert.equal(existsSync(`${path}.lock`), false);
  const checkedRecord = JSON.parse(readFileSync(join(env.EPOCH_RECORD_DIR, files[0]), 'utf8'));
  assert.equal(checkedRecord.publishEpochTx, receipt.hash); assert.equal(checkedRecord.hubCarry.transactionHash, job.ascTxHash);
  assert.deepEqual(checkedRecord.checks.map((v: { actual: boolean }) => v.actual), [true, false, true]);
  assert.equal(checkedRecord.sourcePublicationObservation.transactionHash, receipt.hash);
  assert.ok(checkedRecord.sourcePublicationObservation.observedAt >= record.sourcePublicationObservation.observedAt);
  // An isolated pre-confirmation journal emulates the persisted state before a crash after send.
  // It is test-only: operational users must never create another journal to bypass a lease.
  const recoveryPath = join(root, 'pre-confirmation.enc'), recovery = new EpochPublicationJournal(recoveryPath, secret, scope);
  try { recovery.prepare(recovery.begin(originalEntry.intent).id, originalEntry.transaction!.raw); } finally { recovery.close(); }
  const recoveryBytes = readFileSync(recoveryPath);
  const recovered = publish({ ...readonlyEnv, EPOCH_PUBLICATION_JOURNAL_PATH: recoveryPath }, '--check-publication');
  assert.equal(await recovered.exit, 0, recovered.output()); assert.deepEqual(readFileSync(recoveryPath), recoveryBytes);
  const unsignedPath = join(root, 'unsigned.enc'), unsigned = new EpochPublicationJournal(unsignedPath, secret, scope);
  try { unsigned.begin(originalEntry.intent); } finally { unsigned.close(); }
  const unsignedBytes = readFileSync(unsignedPath);
  const unsignedCheck = publish({ ...readonlyEnv, EPOCH_PUBLICATION_JOURNAL_PATH: unsignedPath }, '--check-publication');
  assert.equal(await unsignedCheck.exit, 1, unsignedCheck.output()); assert.match(unsignedCheck.output(), /PUBLICATION_SOURCE_NOT_CONFIRMED/);
  assert.deepEqual(readFileSync(unsignedPath), unsignedBytes);
  const noFloor = publish({ ...readonlyEnv, EPOCH_HUB_FROM_BLOCK: undefined }, '--check-publication');
  assert.equal(await noFloor.exit, 1, noFloor.output()); assert.match(noFloor.output(), /EPOCH_CARRY_CONFIG_INVALID/);
  assert.equal(sends, 1); assert.equal(await src.provider.getTransactionCount(publisher.address), 2);
  assert.equal(await hub.provider.getTransactionCount(workerWallet.address), 1);
  const recordBeforeTamper = readFileSync(join(env.EPOCH_RECORD_DIR, files[0]));
  // A tampered generation must not start a second intent/nonce. No bypass or refresh is used.
  const listPath = join(currentGeneration(rawDir), SOURCES.OFAC_SDN.file), originalList = readFileSync(listPath, 'utf8'); writeFileSync(listPath, originalList + '\n');
  const held = publish(); assert.equal(await held.exit, 1, held.output()); assert.equal(sends, 1);
  assert.deepEqual(readFileSync(join(env.EPOCH_RECORD_DIR, files[0])), recordBeforeTamper);
  assert.equal(await source.lastEpoch(), 1n); assert.equal(await src.provider.getTransactionCount(publisher.address), 2);
  const unchanged = new EpochPublicationJournal(path, secret, scope);
  try { assert.equal(unchanged.snapshot().length, 1); assert.equal(unchanged.snapshot()[0].transaction!.hash, acceptedHash); } finally { unchanged.close(); }
  // Normal worker restart scans new empty blocks without re-proving or re-sending its done job.
  await src.provider.send('anvil_mine', ['0x2']);
  const targetCursor = (await src.provider.getBlock('finalized'))!.number, restarted = worker();
  for (let i = 0; new Store(workerPath).cursor < targetCursor; i++) {
    assert.equal(restarted.child.exitCode, null, restarted.output()); if (i >= 100) throw Error(`worker restart scan stalled: ${restarted.output()}`); await delay(50);
  }
  restarted.child.kill('SIGTERM'); assert.deepEqual(await restarted.exit, { code: 0, signal: null });
  assert.equal(new Store(workerPath).get(receipt.hash)!.ascTxHash, job.ascTxHash);
  assert.equal(new Store(workerPath).get(receipt.hash)!.relayHistory!.length, 1);
  assert.equal(await hub.provider.getTransactionCount(workerWallet.address), 1);
  assert.equal(attestationCalls, 1); assert.equal(proofCalls, 1); assert.deepEqual(serviceErrors, []);
  // A later counter is not acceptance of this publication. Restore only the owned fixture
  // bytes, publish epoch 2 with the worker stopped, and lie about latestEpoch via local RPC.
  writeFileSync(listPath, originalList);
  const counterProxy = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body); assert.equal(Array.isArray(call), false);
      const later = call.method === 'eth_call' && call.params[0].to.toLowerCase() === env.ASC_CONTRACT_ADDRESS.toLowerCase()
        && call.params[0].data === asc.interface.encodeFunctionData('latestEpoch');
      const result = later ? asc.interface.encodeFunctionResult('latestEpoch', [3]) : await hub.provider.send(call.method, call.params);
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (error) { proxyErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(r => counterProxy.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => { counterProxy.close(() => r()); counterProxy.closeAllConnections(); }));
  const skipped = publish({ CREDITCOIN_RPC_URL: `http://127.0.0.1:${(counterProxy.address() as { port: number }).port}` });
  assert.equal(await skipped.exit, 1, skipped.output()); assert.match(skipped.output(), /EPOCH_HUB_SUPERSEDED_UNCONFIRMED/);
  assert.equal(await source.lastEpoch(), 2n); assert.equal(await asc.latestEpoch(), 1n);
  assert.equal(sends, 2); assert.equal(await src.provider.getTransactionCount(publisher.address), 3);
  const secondFile = readdirSync(env.EPOCH_RECORD_DIR).find(f => f.endsWith('-2.json'))!;
  const sourceOnly = JSON.parse(readFileSync(join(env.EPOCH_RECORD_DIR, secondFile), 'utf8'));
  assert.equal(sourceOnly.epoch, 2); assert.equal(sourceOnly.publishEpochTx, acceptedHash);
  for (const field of ['hubCarry', 'cc3AcceptedAt', 'propagationSeconds', 'checks', 'checkedAt', 'sourcePublicationObservation']) assert.equal(sourceOnly[field], undefined);
  const secondBytes = readFileSync(join(env.EPOCH_RECORD_DIR, secondFile)), secondJournal = readFileSync(path);
  const notCarried = publish(readonlyEnv, '--check-publication');
  assert.equal(await notCarried.exit, 1, notCarried.output()); assert.match(notCarried.output(), /PUBLICATION_HUB_NOT_CONFIRMED/);
  assert.deepEqual(readFileSync(path), secondJournal); assert.deepEqual(readFileSync(join(env.EPOCH_RECORD_DIR, secondFile)), secondBytes);
  assert.equal(sends, 2); assert.equal(await src.provider.getTransactionCount(publisher.address), 3);
  assert.equal(await hub.provider.getTransactionCount(workerWallet.address), 1);
  // Actual source reorg after the current-policy verdict calls. The older source cutoff and
  // all hub state stay intact, so checking only cutoff/hub canonicality would wrongly pass.
  const firstRecordPath = join(env.EPOCH_RECORD_DIR, files[0]), firstSnippetPath = firstRecordPath.replace(/\.json$/, '.md');
  const firstBytes = readFileSync(firstRecordPath), firstSnippet = readFileSync(firstSnippetPath);
  let revertedDuringCheck = false;
  const reorgProxy = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body); assert.equal(Array.isArray(call), false);
      const result = await hub.provider.send(call.method, call.params);
      if (!revertedDuringCheck && call.method === 'eth_call' && call.params[0].to.toLowerCase() === env.REGISTRY_CONTRACT_ADDRESS.toLowerCase()
        && call.params[0].data.startsWith(registry.interface.getFunction('proveNotInRoster')!.selector)) {
        assert.equal(await src.provider.send('evm_revert', [beforePublication]), true); revertedDuringCheck = true;
      }
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (error) { proxyErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(r => reorgProxy.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => { reorgProxy.close(() => r()); reorgProxy.closeAllConnections(); }));
  const finalReorg = publish({ ...readonlyEnv, EPOCH_PUBLICATION_JOURNAL_PATH: recoveryPath,
    CREDITCOIN_RPC_URL: `http://127.0.0.1:${(reorgProxy.address() as { port: number }).port}` }, '--check-publication');
  assert.equal(await finalReorg.exit, 1, finalReorg.output()); assert.equal(revertedDuringCheck, true);
  assert.match(finalReorg.output(), /PUBLICATION_CONFIRMATION_CHANGED/); assert.doesNotMatch(finalReorg.output(), /all verdicts match expectation/);
  assert.deepEqual(readFileSync(firstRecordPath), firstBytes); assert.deepEqual(readFileSync(firstSnippetPath), firstSnippet);
  assert.deepEqual(readFileSync(recoveryPath), recoveryBytes); assert.equal(existsSync(`${recoveryPath}.lock`), false);
  assert.equal(await source.lastEpoch(), 0n); assert.equal(await src.provider.getTransactionReceipt(receipt.hash), null);
  assert.equal((await src.provider.getBlock(originalEntry.intent.sourceCutoff.blockNumber))!.hash, originalEntry.intent.sourceCutoff.blockHash);
  assert.equal(await asc.latestEpoch(), 1n); assert.equal(await src.provider.getTransactionCount(publisher.address), 1);
  assert.equal(sends, 2); assert.equal(await hub.provider.getTransactionCount(workerWallet.address), 1);
  assert.deepEqual(proxyErrors, []);
});
