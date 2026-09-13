import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider } from '../pipeline/issuance-evm.js';
import { buildRoster, inclusionProof, leafIndexOf } from '../pipeline/roster.js';
import { EpochPublicationJournal } from '../pipeline/epoch-publication-journal.js';
import { PUBLICATION_ABI, advancePublication, evmPublicationTransport } from '../pipeline/epoch-publication-delivery.js';
import { packAttrs } from '../pipeline/attrs.js';
import { buildSourceRoster } from '../pipeline/roster-source.js';

test('actual source publication: presaved raw, lost acknowledgement, depth, CLI recovery and source reorg hold', { timeout: 60000 }, async t => {
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => { const errors: unknown[] = []; for (const fn of cleanup.reverse()) { try { await fn(); } catch (e) { errors.push(e); } } if (errors.length) throw new AggregateError(errors); });
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-epoch-delivery-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  async function chain(id: number) {
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
    const child = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(id), '--timestamp', '1800000000', '--silent'], { stdio: 'ignore' });
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await exited; } });
    const url = `http://127.0.0.1:${port}`, provider = issuanceProvider(url); cleanup.push(() => provider.destroy());
    for (let n = 0; ; n++) { try { await provider.getBlockNumber(); break; } catch { if (n >= 30 || child.exitCode !== null) throw new Error('isolated Anvil unavailable'); await delay(100); } }
    return { url, provider };
  }
  const sourceRpc = await chain(11155111), hubRpc = await chain(102031);
  const sourceHeaders = issuanceProvider(sourceRpc.url); cleanup.push(() => sourceHeaders.destroy());
  // A second URL exercises the separate-provider guard. Both URLs intentionally terminate at
  // this one owned Anvil; production SOURCE_HEADER_RPC_URL must be independently operated.
  const headerUrl = `${sourceRpc.url}/?synthetic-independent-header=1`;
  const key = (i: number) => ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${i}`).privateKey;
  const owner = new ethers.Wallet(key(0), sourceRpc.provider), publisher = new ethers.Wallet(key(1), sourceRpc.provider), hubOwner = new ethers.Wallet(key(0), hubRpc.provider);
  async function deploy(name: string, signer: ethers.Wallet, args: unknown[], library?: string) {
    const artifact = JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'));
    let bytes: string = artifact.bytecode.object;
    for (const libraries of Object.values(artifact.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
      for (const [name, offsets] of Object.entries(libraries)) {
        assert.equal(name, 'EvmV1Decoder'); assert.ok(library);
        for (const offset of offsets) { assert.equal(offset.length, 20); const start = 2 + offset.start * 2; bytes = bytes.slice(0, start) + library.slice(2) + bytes.slice(start + 40); }
      }
    }
    const deployed = await new ethers.ContractFactory(artifact.abi, bytes, signer).deploy(...args); await deployed.waitForDeployment();
    return { contract: new ethers.Contract(await deployed.getAddress(), artifact.abi, signer), tx: deployed.deploymentTransaction()!.hash };
  }
  const { contract: source, tx: deploymentTx } = await deploy('ComplianceSource', owner, [owner.address]);
  await (await source.setIssuer(publisher.address, true)).wait(); await (await source.setEpochPublisher(publisher.address, true)).wait();
  const { contract: decoder } = await deploy('EvmV1Decoder', hubOwner, []);
  const { contract: asc } = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();
  const { contract: registry } = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);
  const cutoff = (await sourceRpc.provider.getBlock('latest'))!;
  const intent = { calldata: PUBLICATION_ABI.encodeFunctionData('publishEpoch', [1, buildRoster([]).root, 1, cutoff.timestamp + 86400, cutoff.timestamp, ethers.id('synthetic-snapshot')]),
    sourceCutoff: { blockNumber: cutoff.number, blockHash: cutoff.hash! }, createdAt: Date.now() };
  const path = join(dir, 'publisher.enc'), secret = 'synthetic-epoch-publication-journal-key-at-least-32-characters';
  const scope = { chainId: 11155111, source: await source.getAddress(), publisher: publisher.address };
  let journal = new EpochPublicationJournal(path, secret, scope); cleanup.push(() => journal.close());
  const begun = journal.begin(intent), fork = await sourceRpc.provider.send('evm_snapshot', []);
  let prepared = 0, broadcasts = 0;
  // Official AML/roster readiness is an explicit fixture here, not bypassed in the actual CLI.
  const transport = evmPublicationTransport(sourceRpc.provider, publisher, journal, 2, async () => {});
  const sign = transport.prepare.bind(transport), broadcast = transport.broadcast.bind(transport);
  transport.prepare = async e => { prepared++; return sign(e); };
  transport.broadcast = async e => {
    assert.equal(journal.snapshot()[0].transaction!.raw, e.transaction!.raw, 'raw is durable before RPC send');
    broadcasts++; await broadcast(e); throw new Error('SYNTHETIC_LOST_ACK');
  };
  assert.equal((await advancePublication(journal, begun.id, transport)).state, 'confirming');
  const raw = journal.snapshot()[0].transaction!.raw, hash = ethers.keccak256(raw);
  assert.equal(await source.lastEpoch(), 1n); assert.equal(await sourceRpc.provider.getTransactionCount(publisher.address), 1);
  assert.throws(() => journal.begin({ ...intent, createdAt: intent.createdAt + 1 }), /PUBLICATION_PENDING/);
  assert.throws(() => new EpochPublicationJournal(path, secret, scope), /PUBLICATION_JOURNAL_BUSY/);
  journal.close(); journal = new EpochPublicationJournal(path, secret, scope);
  const recovering = evmPublicationTransport(sourceRpc.provider, publisher, journal, 2, async () => { throw new Error('confirmed recovery must not build fresh data'); });
  assert.equal((await advancePublication(journal, begun.id, recovering)).state, 'confirming');
  await sourceRpc.provider.send('anvil_mine', ['0x50']);
  const receipt = (await sourceRpc.provider.getTransactionReceipt(hash))!;
  const missingEvents = t.mock.method(sourceRpc.provider, 'getTransactionReceipt', async () => ({ ...receipt, logs: [] } as unknown as ethers.TransactionReceipt));
  try { await assert.rejects(recovering.observe(journal.snapshot()[0]), /PUBLICATION_EVENT_MISMATCH/); }
  finally { missingEvents.mock.restore(); }
  const authTopic = PUBLICATION_ABI.getEvent('RosterIssuerAuthorized')!.topicHash;
  const missingAuth = t.mock.method(sourceRpc.provider, 'getTransactionReceipt', async () => ({ ...receipt, logs: receipt.logs.filter(l => l.topics[0] !== authTopic) } as unknown as ethers.TransactionReceipt));
  try { await assert.rejects(recovering.observe(journal.snapshot()[0]), /PUBLICATION_AUTH_EVENT_MISMATCH/); }
  finally { missingAuth.mock.restore(); }
  const head = await sourceRpc.provider.getBlockNumber(); let reads = 0;
  const recedingHead = t.mock.method(sourceRpc.provider, 'getBlockNumber', async () => ++reads === 1 ? head : receipt.blockNumber);
  try { assert.equal((await recovering.observe(journal.snapshot()[0])).state, 'confirming', 'depth must survive the final observation boundary'); }
  finally { recedingHead.mock.restore(); }
  const result = await advancePublication(journal, begun.id, recovering); assert.equal(result.state, 'confirmed');
  assert.equal(journal.snapshot()[0].transaction!.raw, raw); assert.equal(prepared, 1); assert.equal(broadcasts, 1);
  journal.close();
  const env = { PATH: process.env.PATH, DOTENV_CONFIG_PATH: join(dir, 'absent.env'), SOURCE_CHAIN_RPC_URL: sourceRpc.url,
    SOURCE_HEADER_RPC_URL: headerUrl, CREDITCOIN_RPC_URL: hubRpc.url,
    DEMO_EXPECTED_ISSUER: publisher.address,
    // Expected codes are established from this owned deployment before fault injection; these
    // synthetic pins are not independently approved production release evidence.
    DEMO_SOURCE_CODEHASH: ethers.keccak256(await sourceRpc.provider.getCode(scope.source)),
    DEMO_ASC_CODEHASH: ethers.keccak256(await hubRpc.provider.getCode(await asc.getAddress())),
    DEMO_REGISTRY_CODEHASH: ethers.keccak256(await hubRpc.provider.getCode(await registry.getAddress())),
    SOURCE_CONTRACT_ADDRESS: scope.source, ASC_CONTRACT_ADDRESS: await asc.getAddress(), REGISTRY_CONTRACT_ADDRESS: await registry.getAddress(),
    SOURCE_DEPLOYMENT_TX: deploymentTx, SOURCE_CONFIRMATIONS: '2', EPOCH_SOURCE_WAIT_SECONDS: '1',
    SOURCE_SNAPSHOT_CHECKPOINT_PATH: join(dir, 'source-checkpoint.enc'),
    SOURCE_SNAPSHOT_CHECKPOINT_KEY: 'synthetic-source-checkpoint-secret-at-least-32-characters',
    EPOCH_PUBLICATION_JOURNAL_PATH: path, EPOCH_PUBLICATION_JOURNAL_KEY: secret, EPOCH_PUBLISHER_PRIVATE_KEY: publisher.privateKey,
    EPOCH_PUBLISHER_ADDRESS: publisher.address,
    EPOCH_BUNDLE_DISCLOSURE_ACK: 'wallet-linkable-roster-approved',
    EPOCH_BUNDLE_REPLICA_DIRS: JSON.stringify([join(dir, 'roster-replica-a'), join(dir, 'roster-replica-b')]),
    EPOCH_RECORD_DIR: join(dir, 'records') };
  const cli = (mode: string) => spawnSync(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', mode], { cwd: resolve('.'), env, encoding: 'utf8', timeout: 15000, maxBuffer: 512 * 1024 });
  const resumed = cli('--resume-publication');
  assert.equal(resumed.error, undefined); assert.equal(resumed.status, 2, resumed.stderr + resumed.stdout);
  assert.match(resumed.stdout, /CC3 materialization NOT_CHECKED/); assert.match(resumed.stdout, new RegExp(hash));
  assert.equal(resumed.stdout.includes(raw), false); assert.equal(resumed.stderr.includes(publisher.privateKey), false);
  assert.equal(existsSync(`${path}.lock`), false);
  const files = readdirSync(env.EPOCH_RECORD_DIR).filter(f => f.endsWith('.json')); assert.equal(files.length, 1);
  const record = JSON.parse(readFileSync(join(env.EPOCH_RECORD_DIR, files[0]), 'utf8'));
  assert.equal(record.publishEpochTx, hash); assert.equal(record.sourceSnapshot.cutoffBlockHash, cutoff.hash);
  assert.equal(record.root, buildRoster([]).root); assert.equal(record.cc3AcceptedAt, undefined);
  // An old observation must not survive a source-only recovery as apparently current proof.
  const recordFile = join(env.EPOCH_RECORD_DIR, files[0]), snippetFile = recordFile.replace(/\.json$/, '.md');
  writeFileSync(recordFile, JSON.stringify({ ...record, checkedAt: 'past', registryProofMode: true,
    checks: [{ actual: true }], cc3AcceptedAt: 'past', propagationSeconds: 1, propagationMethod: 'past', sourcePublicationObservation: { observedAt: 1 } }));
  writeFileSync(snippetFile, 'STALE SUBMISSION PASS');
  const rechecked = cli('--resume-publication'); assert.equal(rechecked.status, 2, rechecked.stderr + rechecked.stdout);
  const currentRecord = JSON.parse(readFileSync(recordFile, 'utf8'));
  for (const field of ['checkedAt', 'registryProofMode', 'checks', 'cc3AcceptedAt', 'propagationSeconds', 'propagationMethod', 'sourcePublicationObservation']) assert.equal(currentRecord[field], undefined);
  assert.equal(currentRecord.publishEpochTx, hash);
  assert.match(readFileSync(snippetFile, 'utf8'), /verification not established/);
  assert.doesNotMatch(readFileSync(snippetFile, 'utf8'), /STALE SUBMISSION PASS/);
  assert.equal(await asc.latestEpoch(), 0n); assert.equal(await sourceRpc.provider.getTransactionCount(publisher.address), 1);
  assert.equal(await sourceRpc.provider.send('evm_revert', [fork]), true);
  await sourceRpc.provider.send('anvil_mine', ['0x50']);
  const held = cli('--publish');
  assert.equal(held.status, 1, held.stderr + held.stdout); assert.match(held.stderr, /PUBLICATION_CONFIRMATION_CHANGED/);
  assert.equal(await sourceRpc.provider.getTransactionCount(publisher.address), 0, 'no new nonce after confirmed history disappears');
  assert.equal(existsSync(`${path}.lock`), false, 'durable confirmation remains; normal lease release is not a force unlock');

  // A different dedicated publisher/key exercises a real canonical revert without bypassing
  // the first publisher's held history through another path.
  const secondPublisher = new ethers.Wallet(key(2), sourceRpc.provider);
  await (await source.setIssuer(secondPublisher.address, true)).wait();
  await (await source.setEpochPublisher(secondPublisher.address, true)).wait();
  const secondCutoff = (await sourceRpc.provider.getBlock('latest'))!;
  const secondPath = join(dir, 'second-publisher.enc');
  const secondScope = { ...scope, publisher: secondPublisher.address };
  const secondJournal = new EpochPublicationJournal(secondPath, secret, secondScope); cleanup.push(() => secondJournal.close());
  const second = secondJournal.begin({ calldata: PUBLICATION_ABI.encodeFunctionData('publishEpoch', [1, buildRoster([]).root, 1, secondCutoff.timestamp + 86400, secondCutoff.timestamp, ethers.id('second-synthetic-snapshot')]),
    sourceCutoff: { blockNumber: secondCutoff.number, blockHash: secondCutoff.hash! }, createdAt: Date.now() });
  const reverting = evmPublicationTransport(sourceRpc.provider, secondPublisher, secondJournal, 2, async () => {});
  await reverting.assertReady(second);
  const secondSigned = secondJournal.prepare(second.id, await reverting.prepare(second));
  await (await source.setEpochPublisher(secondPublisher.address, false)).wait();
  await reverting.broadcast(secondSigned); await sourceRpc.provider.send('anvil_mine', ['0x1']);
  const reverted = await advancePublication(secondJournal, second.id, reverting);
  assert.equal(reverted.state, 'confirmed'); if (reverted.state !== 'confirmed') throw new Error('missing reverted observation');
  assert.equal(reverted.confirmation.status, 0); assert.equal(await source.lastEpoch(), 0n);
  assert.equal(await sourceRpc.provider.getTransactionCount(secondPublisher.address), 1);
  const unsigned = secondJournal.begin({ ...second.intent, createdAt: second.intent.createdAt + 1 });
  secondJournal.close();
  const cancel = spawnSync(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', '--cancel-unsigned-publication'], { cwd: resolve('.'),
    env: { ...env, EPOCH_PUBLICATION_JOURNAL_PATH: secondPath, EPOCH_PUBLISHER_PRIVATE_KEY: secondPublisher.privateKey,
      EPOCH_PUBLISHER_ADDRESS: secondPublisher.address }, encoding: 'utf8', timeout: 15000 });
  assert.equal(cancel.status, 0, cancel.stdout + cancel.stderr);
  const cancelled = new EpochPublicationJournal(secondPath, secret, secondScope); cleanup.push(() => cancelled.close());
  assert.equal(cancelled.snapshot().find(e => e.id === unsigned.id)!.abandonment?.reason, 'UNSIGNED_PLAN_CANCELLED');
  assert.equal(await sourceRpc.provider.getTransactionCount(secondPublisher.address), 1);

  // Actual child-process deaths around the production delivery boundary, followed by actual
  // CLI receipt recovery. Readiness in the sender harness remains a synthetic fixture.
  const crashPublisher = new ethers.Wallet(key(3), sourceRpc.provider);
  await (await source.setIssuer(crashPublisher.address, true)).wait();
  await (await source.setEpochPublisher(crashPublisher.address, true)).wait();
  const crashCutoff = (await sourceRpc.provider.getBlock('latest'))!;
  const crashIntent = { calldata: PUBLICATION_ABI.encodeFunctionData('publishEpoch', [1, buildRoster([]).root, 1,
    crashCutoff.timestamp + 86400, crashCutoff.timestamp, ethers.id('crash-synthetic-snapshot')]),
    sourceCutoff: { blockNumber: crashCutoff.number, blockHash: crashCutoff.hash! }, createdAt: Date.now() };
  const crashPath = join(dir, 'crash-publisher.enc'), crashScope = { ...scope, publisher: crashPublisher.address };
  let originalRaw: string | undefined;
  const crashEnv = { ...env, EPOCH_PUBLICATION_JOURNAL_PATH: crashPath, EPOCH_PUBLISHER_PRIVATE_KEY: crashPublisher.privateKey,
    EPOCH_PUBLISHER_ADDRESS: crashPublisher.address,
    DEMO_EXPECTED_ISSUER: crashPublisher.address,
    EPOCH_RECORD_DIR: join(dir, 'crash-records') };
  for (const stage of ['presaved', 'accepted']) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'test/fixtures/epoch-publication-crash.ts'], { cwd: resolve('.'),
      env: { PATH: process.env.PATH, TEST_SOURCE_RPC: sourceRpc.url, TEST_SOURCE_ADDRESS: scope.source,
        TEST_JOURNAL_PATH: crashPath, TEST_JOURNAL_SECRET: secret, TEST_INTENT: JSON.stringify(crashIntent), TEST_CRASH_STAGE: stage },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errors = ''; child.stderr!.on('data', data => errors = (errors + data).slice(-4000));
    const exited = new Promise<{ code: number | null; signal: string | null }>(r => child.once('exit', (code, signal) => r({ code, signal })));
    cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
    const reached = new Promise<{ stage: string; hash: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`publisher crash gate timeout: ${errors}`)), 10000);
      child.once('message', message => { clearTimeout(timeout); resolve(message as { stage: string; hash: string }); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error(`publisher exited before gate: ${errors}`)); });
    });
    const message = await reached; assert.equal(message.stage, stage);
    const bytes = readFileSync(crashPath), lockPath = `${crashPath}.lock`;
    assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).pid, child.pid);
    assert.throws(() => new EpochPublicationJournal(crashPath, secret, crashScope), /PUBLICATION_JOURNAL_BUSY/);
    child.kill('SIGKILL'); assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    assert.ok(existsSync(lockPath)); assert.deepEqual(readFileSync(crashPath), bytes);
    const refused = spawnSync(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', '--resume-publication'],
      { cwd: resolve('.'), env: crashEnv, encoding: 'utf8', timeout: 15000 });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /PUBLICATION_JOURNAL_BUSY/); assert.deepEqual(readFileSync(crashPath), bytes);
    assert.equal(await sourceRpc.provider.getTransactionCount(crashPublisher.address), stage === 'accepted' ? 1 : 0);
    // Test-only owner recovery: exact child's exit was awaited, and only its owned lock is
    // preserved under an evidence name. This is not a production PID/TTL takeover mechanism.
    renameSync(lockPath, `${lockPath}.crashed-${child.pid}`);
    const recovered = new EpochPublicationJournal(crashPath, secret, crashScope);
    try {
      const saved = recovered.snapshot(); assert.equal(saved.length, 1); assert.equal(saved[0].confirmation, undefined);
      assert.deepEqual(saved[0].intent, crashIntent); assert.equal(saved[0].transaction!.hash, message.hash);
      if (originalRaw) assert.equal(saved[0].transaction!.raw, originalRaw);
      originalRaw = saved[0].transaction!.raw; assert.equal(saved[0].transaction!.nonce, 0);
      assert.equal(bytes.includes(originalRaw), false); assert.equal(bytes.includes(crashPublisher.privateKey), false);
    } finally { recovered.close(); }
  }
  await sourceRpc.provider.send('anvil_mine', ['0x50']);
  const crashResume = spawnSync(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', '--resume-publication'],
    { cwd: resolve('.'), env: crashEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(crashResume.status, 2, crashResume.stdout + crashResume.stderr);
  assert.match(crashResume.stdout, /CC3 materialization NOT_CHECKED/);
  const finalJournal = new EpochPublicationJournal(crashPath, secret, crashScope);
  try {
    assert.equal(finalJournal.snapshot()[0].transaction!.raw, originalRaw);
    assert.equal(finalJournal.snapshot()[0].confirmation!.status, 1);
    assert.equal(finalJournal.snapshot()[0].confirmation!.transactionHash, ethers.keccak256(originalRaw!));
  } finally { finalJournal.close(); }
  assert.equal(await sourceRpc.provider.getTransactionCount(crashPublisher.address), 1);
  assert.equal(await source.lastEpoch(), 1n); assert.equal(await asc.latestEpoch(), 0n);
  assert.equal(readdirSync(dir).filter(f => f.startsWith('crash-publisher.enc.lock.crashed-')).length, 2);

  // Actual --check at one common hub block. Native proof is explicitly mocked, not public carry.
  const demoSubject = '0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2';
  const issueTime = (await sourceRpc.provider.getBlock('latest'))!.timestamp;
  await (await source.connect(crashPublisher).getFunction('issue')(demoSubject, packAttrs({ kind: 1, assurance: 3,
    regime: 2, jurisdiction: 410, methods: 65572, issuedAt: issueTime, expiry: issueTime + 86400, epoch: 0 }),
    ethers.id('fixture-claims'), ethers.id('fixture-evidence'))).wait();
  await sourceRpc.provider.send('anvil_mine', ['0x50']);
  const snapshot = await buildSourceRoster(sourceRpc.provider, { source: scope.source, chainId: 11155111n,
    deploymentTx, confirmations: 2, headerReader: sourceHeaders });
  const checkJournal = new EpochPublicationJournal(crashPath, secret, crashScope);
  let checkHash: string;
  try {
    const next = checkJournal.begin({ calldata: PUBLICATION_ABI.encodeFunctionData('publishEpoch', [2, snapshot.tree.root, 1,
      snapshot.manifest.cutoffTimestamp + 86400, snapshot.manifest.cutoffTimestamp, ethers.id('check-synthetic-snapshot')]),
      sourceCutoff: { blockNumber: snapshot.manifest.cutoffBlock, blockHash: snapshot.manifest.cutoffBlockHash }, createdAt: Date.now() });
    const transport = evmPublicationTransport(sourceRpc.provider, crashPublisher, checkJournal, 2, async () => {});
    await advancePublication(checkJournal, next.id, transport); await sourceRpc.provider.send('anvil_mine', ['0x50']);
    assert.equal((await advancePublication(checkJournal, next.id, transport)).state, 'confirmed');
    checkHash = checkJournal.snapshot().at(-1)!.transaction!.hash;
  } finally { checkJournal.close(); }
  const sourceOnly = spawnSync(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', '--resume-publication'],
    { cwd: resolve('.'), env: crashEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(sourceOnly.status, 2, sourceOnly.stdout + sourceOnly.stderr);
  const epochReceipt = (await sourceRpc.provider.getTransactionReceipt(checkHash!))!;
  const nativeMock = JSON.parse(readFileSync(new URL('../out/MockBlockProver.sol/MockBlockProver.json', import.meta.url), 'utf8'));
  await hubRpc.provider.send('anvil_setCode', ['0x0000000000000000000000000000000000000FD2', nativeMock.deployedBytecode.object]);
  const epochTime = (await sourceRpc.provider.getBlock(epochReceipt.blockNumber))!.timestamp;
  if ((await hubRpc.provider.getBlock('latest'))!.timestamp <= epochTime) await hubRpc.provider.send('evm_setNextBlockTimestamp', [epochTime + 1]);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const payload = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
    [epochReceipt.status, epochReceipt.gasUsed, epochReceipt.logs.map(l => [l.address, [...l.topics], l.data]), '0x']);
  await (await asc.execute(3, 1, epochReceipt.blockNumber, coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', payload]]),
    ethers.zeroPadValue(ethers.toBeHex(epochReceipt.index), 32), [], ethers.ZeroHash, [])).wait();
  for (const regime of [1, 2]) {
    await (await registry.registerPolicy([65572, 2, regime === 1 ? 2592000 : 604800, regime, 410, crashPublisher.address, true, false])).wait();
    await (await registry.freezePolicy(regime)).wait();
  }
  const { createServer: httpServer } = await import('node:http');
  let forkResponse = false, observedTag: string | undefined, fixedBlockReads = 0, verdictReturned = false, forkInjected = false;
  const observedCalls: { method: string; tag: unknown }[] = [], proxyErrors: unknown[] = [];
  const proxy = httpServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const call = JSON.parse(body); assert.equal(Array.isArray(call), false);
      let result = await hubRpc.provider.send(call.method, call.params);
      if (call.method === 'eth_getBlockByNumber' && call.params[0] === 'latest' && !observedTag) {
        observedTag = result.number;
        await hubRpc.provider.send('anvil_mine', ['0x1']); // Head advances, pinned observation must not.
      }
      if (call.method === 'eth_call' || call.method === 'eth_getCode') observedCalls.push({ method: call.method, tag: call.params[1] });
      if (call.method === 'eth_call' && call.params[0].data.startsWith(registry.interface.getFunction('proveNotInRoster')!.selector)) verdictReturned = true;
      if (call.method === 'eth_getBlockByNumber' && call.params[0] === observedTag) {
        fixedBlockReads++;
        if (verdictReturned && forkResponse) { forkInjected = true; result = { ...result, hash: ethers.id('synthetic-final-observation-fork') }; }
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }));
    } catch (error) { proxyErrors.push(error); res.writeHead(500); res.end('{}'); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  cleanup.push(() => new Promise<void>(r => { proxy.close(() => r()); proxy.closeAllConnections(); }));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  async function checked(registryAddress = crashEnv.REGISTRY_CONTRACT_ADDRESS) {
    observedTag = undefined; fixedBlockReads = 0; observedCalls.length = 0; verdictReturned = false; forkInjected = false;
    const child = spawn(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', '--check'],
      { cwd: resolve('.'), env: { ...crashEnv, CREDITCOIN_RPC_URL: proxyUrl, REGISTRY_CONTRACT_ADDRESS: registryAddress }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', b => output = (output + b).slice(-20000)); child.stderr.on('data', b => output = (output + b).slice(-20000));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
    try { const code = await new Promise<number | null>((r, reject) => { child.once('error', reject); child.once('exit', r); }); return { code, output }; }
    finally { clearTimeout(timeout); }
  }
  const checkedRecordPath = join(crashEnv.EPOCH_RECORD_DIR, `epoch-v2-${scope.source.toLowerCase()}-${(await asc.getAddress()).toLowerCase()}-2.json`);
  const passed = await checked(); assert.equal(passed.code, 0, passed.output);
  assert.ok(observedCalls.length >= 15); assert.ok(observedCalls.every(c => c.tag === observedTag));
  const checkedRecord = JSON.parse(readFileSync(checkedRecordPath, 'utf8'));
  assert.equal(checkedRecord.hubObservation.blockNumber, Number(BigInt(observedTag!)));
  assert.equal(checkedRecord.hubObservation.blockHash, (await hubRpc.provider.getBlock(checkedRecord.hubObservation.blockNumber))!.hash);
  assert.deepEqual(checkedRecord.checks.map((c: { actual: boolean }) => c.actual), [true, false, true]);
  assert.equal(checkedRecord.policyObservation.expectedIssuer, crashPublisher.address);
  assert.deepEqual(checkedRecord.policyObservation.policies.map((p: { maxAge: number }) => p.maxAge), [2592000, 604800]);
  assert.equal(checkedRecord.runtimeObservation.source.codeHash, env.DEMO_SOURCE_CODEHASH);
  assert.equal(checkedRecord.runtimeObservation.asc.blockNumber, checkedRecord.hubObservation.blockNumber);
  const previousBytes = readFileSync(checkedRecordPath), previousSnippet = readFileSync(checkedRecordPath.replace(/\.json$/, '.md'));
  forkResponse = true;
  const changed = await checked(); assert.equal(changed.code, 1, changed.output);
  assert.match(changed.output, /EPOCH_HUB_OBSERVATION_CHANGED/);
  assert.ok(forkInjected && fixedBlockReads >= 3); assert.ok(observedCalls.every(c => c.tag === observedTag));
  assert.deepEqual(readFileSync(checkedRecordPath), previousBytes); assert.deepEqual(readFileSync(checkedRecordPath.replace(/\.json$/, '.md')), previousSnippet);
  assert.deepEqual(proxyErrors, []);
  // A real weaker policy can return the same booleans. Reject its configuration, not merely
  // changed verdicts: wildcard issuer and lower assurance are not the approved demo template.
  forkResponse = false;
  const { contract: weakRegistry } = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);
  for (const regime of [1, 2]) {
    await (await weakRegistry.registerPolicy([65572, 1, regime === 1 ? 2592000 : 604800, regime, 410, ethers.ZeroAddress, true, false])).wait();
    await (await weakRegistry.freezePolicy(regime)).wait();
  }
  const index = snapshot.tree.entries.findIndex(e => e.subject.toLowerCase() === demoSubject.toLowerCase());
  const entry = snapshot.tree.entries[index];
  const mark = { attrs: entry.attrs, claimsRoot: entry.claimsRoot, evidenceHash: entry.evidenceHash, issuer: entry.issuer };
  const proof = inclusionProof(snapshot.tree, leafIndexOf(index));
  assert.equal(await weakRegistry.verifyWithRoster(demoSubject, 2, mark, proof), true);
  assert.equal(await weakRegistry.verifyWithRoster(demoSubject, 1, mark, proof), false);
  const weak = await checked(await weakRegistry.getAddress());
  assert.equal(weak.code, 1, weak.output); assert.match(weak.output, /EPOCH_POLICY_MISMATCH/);
  assert.ok(observedCalls.every(c => c.tag === observedTag));
  assert.deepEqual(readFileSync(checkedRecordPath), previousBytes);
  assert.deepEqual(readFileSync(checkedRecordPath.replace(/\.json$/, '.md')), previousSnippet);
  assert.deepEqual(proxyErrors, []);
  // Version-compatible source code is still not the pinned runtime. Add an unreachable STOP
  // byte in this owned Anvil only; the ABI version remains unchanged while the hash differs.
  const originalCode = await sourceRpc.provider.getCode(scope.source);
  await sourceRpc.provider.send('anvil_setCode', [scope.source, originalCode + '00']);
  assert.equal(await source.EPOCH_SCHEMA_VERSION(), 2n);
  const changedRuntime = await checked(); assert.equal(changedRuntime.code, 1, changedRuntime.output);
  assert.match(changedRuntime.output, /EPOCH_RUNTIME_MISMATCH/);
  const resumeRuntime = spawnSync(process.execPath, ['--import', 'tsx', 'script/publish-epoch.ts', '--resume-publication'],
    { cwd: resolve('.'), env: crashEnv, encoding: 'utf8', timeout: 15000 });
  assert.equal(resumeRuntime.status, 1, resumeRuntime.stdout + resumeRuntime.stderr);
  assert.equal(existsSync(`${crashPath}.lock`), false, 'normal pin mismatch releases only its acquired lease');
  assert.deepEqual(readFileSync(checkedRecordPath), previousBytes);
  assert.deepEqual(readFileSync(checkedRecordPath.replace(/\.json$/, '.md')), previousSnippet);
  assert.equal(await sourceRpc.provider.getTransactionCount(crashPublisher.address), 3, 'two epoch transactions plus one fixture issuance; no pin-mismatch send');
});
