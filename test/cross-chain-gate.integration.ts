import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { issuanceProvider, EvmIssuanceTransport } from '../pipeline/issuance-evm.js';
import type { IssuanceEntry } from '../pipeline/issuance-journal.js';
import { DemoIdDocumentVendor, DemoBankAccountVendor } from '../pipeline/adapters/demo.js';
import { KrAdapter } from '../pipeline/adapters/kr.js';
import { ListBackedAmlEngine } from '../aml/engine.js';
import { runIssuance } from '../pipeline/issue.js';
import { SYNTHETIC_INDIVIDUAL_NONFACE_POLICY } from '../pipeline/identity-policy.js';
import { syntheticProfile } from '../pipeline/synthetic-samples.js';
import { buildSourceRoster } from '../pipeline/roster-source.js';
import { rosterApprovalData } from '../pipeline/roster-authorization.js';
import { encodeRosterWitness } from '../pipeline/roster-witness.js';
import { checkDemoFreshness } from '../pipeline/demo-freshness.js';
import { checkRevocation } from '../pipeline/revocation-check.js';
import { EvidenceVault } from '../pipeline/vault.js';
import { deliverRevocations, screenDue } from '../pipeline/rescreen.js';
import { createEvmRevocationTransport } from '../pipeline/rescreen-evm.js';
import { revocationObservation } from '../pipeline/revocation-observation.js';
import { monitorVault } from '../pipeline/vault-monitor.js';
import { exportRosterBundle, loadRosterBundle, type RosterBundle } from '../pipeline/roster-bundle.js';
import { checkBundleProof } from '../pipeline/roster-bundle-chain.js';

const artifact = (name: string) => JSON.parse(readFileSync(new URL(`../out/${name === 'MockBlockProverFailing' ? 'MockBlockProver' : name}.sol/${name}.json`, import.meta.url), 'utf8'));
const PRECOMPILE = '0x0000000000000000000000000000000000000FD2';

test('two local EVMs: actual issuance receipts, ASC state, approved roster witnesses, transfer, revoke and expiry', { timeout: 30000 }, async t => {
  async function chain(chainId: number) {
    const probe = createServer(); await new Promise<void>(r => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as { port: number }).port; await new Promise<void>(r => probe.close(() => r()));
    const process = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', String(chainId), '--timestamp', '1800000000', '--silent'], { stdio: 'ignore' });
    t.after(async () => { if (process.exitCode === null) { process.kill('SIGTERM'); await new Promise(r => process.once('exit', r)); } });
    const provider = issuanceProvider(`http://127.0.0.1:${port}`); t.after(() => provider.destroy());
    for (let n = 0; ; n++) { try { await provider.getBlockNumber(); break; } catch { if (n >= 30 || process.exitCode !== null) throw new Error('local Anvil unavailable'); await delay(100); } }
    assert.equal((await provider.getNetwork()).chainId, BigInt(chainId)); return provider;
  }
  const sourceRpc = await chain(11155111), hubRpc = await chain(102031);
  const sourceHeaderRpc = issuanceProvider(sourceRpc._getConnection().url); t.after(() => sourceHeaderRpc.destroy());
  const key = (n: number) => ethers.HDNodeWallet.fromPhrase('test test test test test test test test test test test junk', undefined, `m/44'/60'/0'/0/${n}`).privateKey;
  const sourceOwner = new ethers.Wallet(key(0), sourceRpc), issuer = new ethers.Wallet(key(1), sourceRpc);
  const revoker = new ethers.Wallet(key(2), sourceRpc);
  const hubOwner = new ethers.Wallet(key(0), hubRpc);
  const alice = ethers.Wallet.createRandom().connect(hubRpc), bob = ethers.Wallet.createRandom().connect(hubRpc);
  const control = ethers.Wallet.createRandom().address;
  await hubRpc.send('anvil_setBalance', [alice.address, ethers.toQuantity(ethers.parseEther('1'))]);
  const deployments = new Map<string, string>();
  async function deploy(name: string, owner: ethers.Wallet, args: unknown[] = [], library?: string) {
    const a = artifact(name); let bytes: string = a.bytecode.object;
    for (const libraries of Object.values(a.bytecode.linkReferences ?? {}) as Record<string, { start: number; length: number }[]>[]) {
      for (const [name, offsets] of Object.entries(libraries)) {
        assert.equal(name, 'EvmV1Decoder'); assert.ok(library);
        for (const offset of offsets) {
          assert.equal(offset.length, 20); const start = 2 + offset.start * 2;
          bytes = bytes.slice(0, start) + library.slice(2) + bytes.slice(start + 40);
        }
      }
    }
    const contract = await new ethers.ContractFactory(a.abi, bytes, owner).deploy(...args);
    await contract.waitForDeployment();
    deployments.set(await contract.getAddress(), contract.deploymentTransaction()!.hash);
    return new ethers.Contract(await contract.getAddress(), a.abi, owner);
  }
  const source = await deploy('ComplianceSource', sourceOwner, [sourceOwner.address]);
  // Keep the exact CREATE receipt; source replay starts at it, not a guessed block floor.
  const deploymentTx = deployments.get(await source.getAddress())!;
  await (await source.setIssuer(issuer.address, true)).wait();
  await (await source.setIssuer(revoker.address, true)).wait();
  await (await source.setEpochPublisher(sourceOwner.address, true)).wait();
  const decoder = await deploy('EvmV1Decoder', hubOwner);
  await hubRpc.send('anvil_setCode', [PRECOMPILE, artifact('MockBlockProver').deployedBytecode.object]);
  const asc = await deploy('ProofmarkASC', hubOwner, [hubOwner.address], await decoder.getAddress());
  await (await asc.configureSource(1, await source.getAddress())).wait();
  const registry = await deploy('ProofmarkRegistry', hubOwner, [await asc.getAddress()]);
  for (const regime of [1, 2]) {
    await (await registry.registerPolicy([65572, 2, regime === 1 ? 2592000 : 604800, regime, 410, issuer.address, true, false])).wait();
    await (await registry.freezePolicy(regime)).wait();
  }
  // Control policy: the same Direct mark remains valid by credential age when a source
  // revocation is not relayed. It must never be the policy behind this storage-only asset.
  await (await registry.registerPolicy([65572, 2, 2592000, 2, 410, issuer.address, false, false])).wait();
  await (await registry.freezePolicy(3)).wait();
  const consumerEnv = { PATH: process.env.PATH, CREDITCOIN_RPC_URL: hubRpc._getConnection().url,
    REGISTRY_CONTRACT_ADDRESS: await registry.getAddress(), ASC_CONTRACT_ADDRESS: await asc.getAddress(), SOURCE_CONTRACT_ADDRESS: await source.getAddress(),
    DEMO_REGISTRY_CODEHASH: ethers.keccak256(await hubRpc.getCode(await registry.getAddress())),
    DEMO_ASC_CODEHASH: ethers.keccak256(await hubRpc.getCode(await asc.getAddress())) };
  async function consumer(subject: string, verified: boolean, overrides: NodeJS.ProcessEnv = {}) {
    const before = await hubRpc.getBlockNumber();
    const run = spawnSync(process.execPath, ['--import', 'tsx', 'examples/consumer/check.ts', subject, '2'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { ...consumerEnv, ...overrides },
    });
    const result = JSON.parse(run.stdout);
    if (Object.keys(overrides).length) { assert.equal(run.status, 2, run.stderr); assert.equal(result.verdict, 'unavailable'); assert.equal(result.verified, null); }
    else {
      assert.equal(run.status, 0, run.stderr); assert.equal(result.verified, verified); assert.equal(result.verdict, verified ? 'accepted' : 'rejected');
      assert.equal(result.observation.blockNumber, before); assert.equal(result.policy.id, '2'); assert.equal(result.policy.kind, 1);
      assert.equal(result.policy.frozen, true); assert.equal(result.policy.requireRoster, true);
    }
    assert.equal(await hubRpc.getBlockNumber(), before, 'consumer read submits no transaction');
    return result;
  }
  const note = await deploy('GatedRwaNote', hubOwner, ['Local synthetic note', 'LTEST', await registry.getAddress(), 2, hubOwner.address]);
  const held = new ethers.Contract(await note.getAddress(), artifact('GatedRwaNote').abi, alice);
  async function rejectedTransfer(to: string, error: 'RecipientNotVerified' | 'SenderNotVerified') {
    const expected = note.interface.encodeErrorResult(error, [error === 'SenderNotVerified' ? alice.address : to, 2]);
    await assert.rejects(held.transfer.staticCall(to, 1n), (e: unknown) => (e as { data?: string }).data === expected);
    const tx = await held.transfer(to, 1n, { gasLimit: 200000 });
    await assert.rejects(tx.wait(), (e: unknown) => {
      const failure = e as { code?: string; receipt?: ethers.TransactionReceipt };
      return failure.code === 'CALL_EXCEPTION' && failure.receipt?.status === 0 && failure.receipt.hash === tx.hash;
    });
  }

  // This is a decoder-format receipt wrapper containing ACTUAL local source logs. Native
  // inclusion/continuity verification is explicitly mocked, not an Attestcoin proof.
  function encoded(receipt: ethers.TransactionReceipt) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const payload = coder.encode(['uint8', 'uint64', 'tuple(address,bytes32[],bytes)[]', 'bytes'],
      [receipt.status, receipt.gasUsed, receipt.logs.map(log => [log.address, [...log.topics], log.data]), '0x']);
    return coder.encode(['uint8', 'bytes[]'], [2, ['0x', '0x', payload]]);
  }
  async function relay(receipt: ethers.TransactionReceipt, action: number) {
    const sourceBlock = (await sourceRpc.getBlock(receipt.blockNumber))!;
    if ((await hubRpc.getBlock('latest'))!.timestamp <= sourceBlock.timestamp) await hubRpc.send('evm_setNextBlockTimestamp', [sourceBlock.timestamp + 1]);
    const args = [action, 1, receipt.blockNumber, encoded(receipt), ethers.zeroPadValue(ethers.toBeHex(receipt.index), 32), [], ethers.ZeroHash, []];
    const tx = await asc.execute(...args); const hubReceipt = await tx.wait(); assert.equal(hubReceipt.status, 1);
    await assert.rejects(asc.execute.staticCall(...args), /Query already processed/);
    return hubReceipt;
  }

  const profile = syntheticProfile('success'); const idVendor = new DemoIdDocumentVendor(0), bankVendor = new DemoBankAccountVendor(0);
  const adapter = new KrAdapter(idVendor, bankVendor, { sandboxBits: true });
  const engine = new ListBackedAmlEngine({ entries: [{ listId: 'OFAC_SDN', entryId: 'FICTIONAL-NOT-OFFICIAL', primaryName: 'Zorvax Quenlith',
    names: ['Zorvax Quenlith'], dobs: ['1980-01-01'], countries: ['KR'], programs: [], cryptoAddresses: [], type: 'individual' }],
    listVersions: { OFAC_SDN: 1 }, evidenceKey: 'synthetic-local-gate-only-not-a-production-key' });
  const entries: IssuanceEntry[] = [];
  for (const subject of [alice.address, bob.address]) {
    const id = await idVendor.verify({ ...profile.doc, docType: 'RRC', image: new Uint8Array([1, 2, 3]) });
    assert.equal(id.kind, 'verified'); if (id.kind !== 'verified') throw new Error('fixture ID unavailable');
    const now = (await sourceRpc.getBlock('latest'))!.timestamp * 1000;
    const outcome = await runIssuance({ wallet: subject, walletControlProven: true, jurisdiction: 410, assurance: 3,
      identityPolicy: SYNTHETIC_INDIVIDUAL_NONFACE_POLICY,
      declared: { fullName: profile.doc.fullName, dateOfBirth: '2000-01-01', ...profile.country }, idDocument: id,
      bankAccount: { bankCode: '004', holderName: profile.doc.fullName, holderVerified: true, oneWonVerified: true, vendor: 'demo:bank', live: false },
    }, adapter, engine, now);
    assert.equal(outcome.status, 'ISSUED'); if (outcome.status !== 'ISSUED') throw new Error('fixture not issued');
    assert.equal(outcome.regime, 2);
    const entry: IssuanceEntry = { version: 1, requestId: ethers.id(`local-${subject}`), wallet: subject, fingerprint: ethers.id(`input-${subject}`),
      consentVersion: 'synthetic-integration-no-person', createdAt: now, prepareUntil: now + 900000, phase: 'prepared',
      target: { chainId: 11155111, source: await source.getAddress(), issuer: issuer.address, hubChainId: 102031, asc: await asc.getAddress() },
      outcome, assurance: 3, evidenceStored: true, revertedTransactions: [] };
    const transport = new EvmIssuanceTransport(sourceRpc, hubRpc, issuer, 1, entry.target);
    await transport.assertTarget(entry); entry.transaction = await transport.prepare(entry); await transport.broadcast(entry.transaction);
    const confirmed = await transport.receipt(entry); assert.equal(confirmed.status, 'success');
    if (confirmed.status !== 'success') throw new Error('source receipt missing');
    assert.equal(await transport.materialized(entry, confirmed.confirmation), false);
    const receipt = (await sourceRpc.getTransactionReceipt(entry.transaction.hash))!;
    if (!entries.length) {
      await hubRpc.send('anvil_setCode', [PRECOMPILE, artifact('MockBlockProverFailing').deployedBytecode.object]);
      await assert.rejects(asc.execute.staticCall(0, 1, receipt.blockNumber, encoded(receipt), ethers.ZeroHash, [], ethers.ZeroHash, []));
      assert.equal((await asc.getMark(subject))[0], 0n);
      await hubRpc.send('anvil_setCode', [PRECOMPILE, artifact('MockBlockProver').deployedBytecode.object]);
    }
    await relay(receipt, 0);
    assert.equal(await transport.materialized(entry, confirmed.confirmation), true);
    assert.equal(await registry.isVerified(subject, 2), false, 'Direct materialization does not satisfy roster policy');
    entries.push(entry);
  }
  async function publish(epoch: number) {
    await sourceRpc.send('anvil_mine', ['0x41']);
    const snapshot = await buildSourceRoster(sourceRpc, { source: await source.getAddress(), chainId: 11155111n,
      deploymentTx, confirmations: 1, headerReader: sourceHeaderRpc });
    const cutoff = snapshot.manifest.cutoffTimestamp;
    const approval = rosterApprovalData(11155111n, await source.getAddress(), { epoch, root: snapshot.tree.root,
      listVersion: 1, sourceCutoff: cutoff, validUntil: cutoff + 86400, snapshotId: ethers.id(`FICTIONAL-SNAPSHOT-${epoch}`), publisher: sourceOwner.address });
    const m = approval.value; const signature = await issuer.signTypedData(approval.domain, approval.types, m);
    const receipt = await (await source.publishEpochForIssuers(m.epoch, m.root, m.listVersion, m.validUntil, m.sourceCutoff, m.snapshotId,
      [{ issuer: issuer.address, signature }])).wait();
    await relay(receipt, 3);
    assert.equal(await asc.epochIssuerApproved(epoch, issuer.address), true);
    const record: Omit<RosterBundle, 'bundleVersion' | 'scope'> = { rosterFormatVersion: 2, epochSchemaVersion: 2, rosterAuthVersion: 1,
      epoch, root: snapshot.tree.root, entries: snapshot.tree.entries, approvedIssuers: [issuer.address],
      listVersion: m.listVersion, sourceCutoff: m.sourceCutoff, validUntil: m.validUntil, snapshotId: m.snapshotId,
      publishedAt: (await sourceRpc.getBlock(receipt.blockNumber))!.timestamp };
    return { snapshot, validUntil: m.validUntil, record };
  }
  const first = await publish(1); assert.equal(first.snapshot.tree.entries.length, 2);
  await consumer(alice.address, false); // Direct materialization and an accepted root are not a stored witness.
  const a1 = encodeRosterWitness(first.record, alice.address), b1 = encodeRosterWitness(first.record, bob.address);
  // Trusted coordinates come from our owned deployment, not from a fetched bundle's scope.
  const consumerScope = { sourceChainId: 11155111, sourceChainKey: 1, hubChainId: 102031,
    source: await source.getAddress(), asc: await asc.getAddress(), registry: await registry.getAddress() };
  const firstBundle = exportRosterBundle(first.record, consumerScope), replica = loadRosterBundle(firstBundle.bytes, firstBundle.contentHash);
  const sourceIssuerNonce = await sourceRpc.getTransactionCount(issuer.address);
  const beforeSimulation = await hubRpc.getBlockNumber();
  const aProof = replica.proof(alice.address);
  if (aProof.kind !== 'inclusion') throw new Error('expected fixture inclusion');
  // An untrusted response's transaction field is not an authorization to call that destination.
  aProof.transaction.to = control; aProof.transaction.data = '0xdeadbeef';
  const aChecked = await checkBundleProof(hubRpc, consumerScope, aProof, 2n);
  const bChecked = await checkBundleProof(hubRpc, consumerScope, replica.proof(bob.address), 2n);
  for (const checked of [aChecked, bChecked]) {
    assert.equal(checked.eligible, true); assert.equal(checked.witnessSimulation, 'succeeded');
    assert.equal(checked.transaction!.to, consumerScope.registry); assert.equal(checked.transaction!.chainId, 102031);
  }
  assert.equal(aChecked.transaction!.data, a1.data); assert.equal(bChecked.transaction!.data, b1.data);
  const production = await checkBundleProof(hubRpc, consumerScope, replica.proof(alice.address), 1n);
  assert.equal(production.eligible, false); assert.equal(production.transaction, undefined);
  const absent = await checkBundleProof(hubRpc, consumerScope, replica.proof(control), 2n);
  assert.equal(absent.kind, 'non-inclusion'); assert.equal(absent.proofAccepted, true);
  assert.equal(absent.eligible, false); assert.equal(absent.transaction, undefined);
  assert.equal(await hubRpc.getBlockNumber(), beforeSimulation, 'bundle proof checks are read-only');
  assert.equal(await registry.isVerified(alice.address, 2), false, 'simulation is not witness storage');
  assert.equal(await note.canTransfer(alice.address, bob.address), false);
  // Only the explicitly owned local wallet sends the re-encoded checked requests. The bundle
  // library does not sign/send. Alice can deliver Bob's approved proof without an issuer key.
  const aWitnessReceipt = await (await alice.sendTransaction(aChecked.transaction!)).wait();
  assert.equal(aWitnessReceipt!.status, 1); assert.equal(aWitnessReceipt!.to, consumerScope.registry);
  assert.equal(await note.canTransfer(alice.address, bob.address), false);
  const bWitnessReceipt = await (await alice.sendTransaction(bChecked.transaction!)).wait(); assert.equal(bWitnessReceipt!.status, 1);
  assert.equal(await sourceRpc.getTransactionCount(issuer.address), sourceIssuerNonce);
  assert.equal(await note.canTransfer(alice.address, bob.address), true);
  await consumer(alice.address, true);
  assert.equal((await consumer(alice.address, true, { DEMO_REGISTRY_CODEHASH: ethers.id('unapproved') })).error, 'CONSUMER_RUNTIME_MISMATCH');
  assert.equal(await registry.isVerified(alice.address, 1), false); assert.equal(await registry.isVerified(bob.address, 1), false);
  const observationTime = (await hubRpc.getBlock('latest'))!.timestamp;
  await checkDemoFreshness(hubRpc, { asc: await asc.getAddress(), registry: await registry.getAddress(), note: await note.getAddress(),
    source: await source.getAddress(), expectedIssuer: issuer.address, holders: [alice.address, bob.address], control, minFreshSeconds: 600 }, observationTime);
  await (await note.mint(alice.address, 100n)).wait(); await (await held.transfer(bob.address, 25n)).wait();
  assert.equal(await note.balanceOf(alice.address), 75n); assert.equal(await note.balanceOf(bob.address), 25n);
  const balances = async () => [await note.balanceOf(alice.address), await note.balanceOf(bob.address), await note.balanceOf(control)];
  const before = await balances();
  await rejectedTransfer(control, 'RecipientNotVerified');
  assert.deepEqual(await balances(), before, 'rejected on-chain transfer changes no balances');

  // T-08 outage counterexample on the actual two local EVMs. The source accepts a real
  // revocation, but the relay worker and epoch publisher perform no further action. At the
  // exact source-cutoff deadline, Direct still accepts the stale issuance while the asset's
  // roster-only policy fails closed. Snapshots keep this independent of the recovery flow below.
  const sourceOutageSnapshot = await sourceRpc.send('evm_snapshot', []);
  const hubOutageSnapshot = await hubRpc.send('evm_snapshot', []);
  const stoppedIssuerNonce = await sourceRpc.getTransactionCount(issuer.address);
  const stoppedPublisherNonce = await sourceRpc.getTransactionCount(sourceOwner.address);
  const outageSource = source.connect(revoker) as ethers.Contract;
  const outageRevocation = await (await outageSource.revoke(alice.address, 2, 1)).wait();
  assert.equal(outageRevocation!.status, 1);
  assert.ok(await sourceRpc.getTransactionReceipt(outageRevocation!.hash), 'source revocation must remain observable');
  assert.equal(await asc.tombstone(alice.address), false, 'stopped relay leaves the hub unaware');
  assert.equal(await asc.latestEpoch(), 1n, 'stopped publisher leaves the accepted root unchanged');
  assert.equal(await registry.isVerified(alice.address, 3), true, 'Direct control remains stale-active');
  await hubRpc.send('evm_setNextBlockTimestamp', [first.validUntil]);
  await hubRpc.send('evm_mine', []);
  assert.equal(await sourceRpc.getTransactionCount(issuer.address), stoppedIssuerNonce, 'issuer sent nothing after outage');
  assert.equal(await sourceRpc.getTransactionCount(sourceOwner.address), stoppedPublisherNonce, 'publisher sent no renewal');
  assert.equal(await registry.isVerified(alice.address, 3), true, 'credential age does not imply relay freshness');
  assert.equal(await registry.isVerified(alice.address, 2), false, 'roster policy expires at cutoff + 24h');
  assert.equal(await note.canTransfer(alice.address, bob.address), false);
  await rejectedTransfer(bob.address, 'SenderNotVerified');
  assert.deepEqual(await balances(), before, 'deadline rejection changes no balances');
  assert.equal(await hubRpc.send('evm_revert', [hubOutageSnapshot]), true);
  assert.equal(await sourceRpc.send('evm_revert', [sourceOutageSnapshot]), true);
  assert.equal(await registry.isVerified(alice.address, 2), true, 'recovery scenario resumes before the deadline');

  const caseDir = mkdtempSync(join(tmpdir(), 'proofmark-local-revoke-case-'));
  t.after(() => rmSync(caseDir, { recursive: true, force: true }));
  const casePath = join(caseDir, 'vault.enc'), caseKey = 'synthetic-local-revocation-check-key-32-characters';
  const vault = new EvidenceVault(casePath, caseKey);
  const bobEntry = entries[1]; assert.equal(bobEntry.wallet, bob.address);
  const bobOutcome = bobEntry.outcome; assert.equal(bobOutcome.status, 'ISSUED');
  if (bobOutcome.status !== 'ISSUED') throw new Error('fixture issuance unavailable');
  const rescreenNow = Math.max((await sourceRpc.getBlock('latest'))!.timestamp * 1000, bobEntry.createdAt + 1);
  vault.put({ id: bobEntry.requestId, walletAddress: bob.address, consentVersion: bobEntry.consentVersion,
    screeningSubject: { fullName: profile.doc.fullName, dateOfBirth: '2000-01-01', ...profile.country, walletAddress: bob.address },
    evidenceHash: bobOutcome.evidenceHash, evidence: bobOutcome.evidence, attrs: bobOutcome.attrs,
    claimsRoot: bobOutcome.claimsRoot, claims: bobOutcome.claims, state: 'pending', createdAt: bobEntry.createdAt,
    retentionUntil: Number.MAX_SAFE_INTEGER, lastScreenedAt: bobEntry.createdAt, reviews: [], rescreens: [] });
  vault.recordSourceConfirmation(bobEntry.requestId, bobOutcome.evidenceHash, { transactionHash: bobEntry.transaction!.hash,
    chainId: 11155111, source: await source.getAddress(), observedAt: rescreenNow });
  vault.recordMaterialization(bobEntry.requestId, bobOutcome.evidenceHash);
  assert.equal(vault.get(bobEntry.requestId)!.state, 'active');
  const baseline = await screenDue(vault, engine, { now: rescreenNow, intervalMs: 1, persist: true });
  assert.equal(baseline.length, 1); assert.equal(baseline[0].decision, 'ALLOW');
  assert.equal(vault.get(bobEntry.requestId)!.rescreens[0].listVersions.OFAC_SDN, 1);
  // A changed FICTIONAL list explicitly lists this random local wallet. Real matcher, no official-data claim.
  const changedEngine = new ListBackedAmlEngine({ entries: [{ listId: 'OFAC_SDN', entryId: 'FICTIONAL-LOCAL-WALLET-ADDED',
    primaryName: 'Zorvax Quenlith', names: ['Zorvax Quenlith'], dobs: [], countries: [], programs: [],
    cryptoAddresses: [bob.address], type: 'individual' }], listVersions: { OFAC_SDN: 2 }, evidenceKey: caseKey });
  const changedAt = rescreenNow + 1;
  const beforePreview = readFileSync(casePath), nonceBefore = await sourceRpc.getTransactionCount(revoker.address);
  const preview = await screenDue(vault, changedEngine, { now: changedAt, intervalMs: 86_400_000, persist: false });
  assert.equal(preview[0].decision, 'BLOCK'); assert.deepEqual(readFileSync(casePath), beforePreview);
  assert.equal(vault.listPendingRevocations().length, 0);
  await screenDue(vault, changedEngine, { now: changedAt, intervalMs: 86_400_000, persist: true });
  assert.equal(vault.get(bobEntry.requestId)!.state, 'blocked');
  assert.deepEqual(vault.get(bobEntry.requestId)!.rescreens.map(event => event.listVersions.OFAC_SDN), [1, 2]);
  assert.equal(await sourceRpc.getTransactionCount(revoker.address), nonceBefore);
  const caseId = vault.listPendingRevocations()[0].id;
  const monitorLimits = { screeningIntervalMs: 1, pendingIssuanceMs: 1, reviewRecordAgeMs: 1, revocationMs: 1, observationMaxAgeMs: 1000 };
  assert.equal(monitorVault(vault.monitoringSnapshot(), monitorLimits, changedAt + 1).counts.REVOCATION_OVERDUE, 1);
  assert.equal(vault.getRevocation(caseId)!.recordId, bobEntry.requestId);
  const sender = await createEvmRevocationTransport(sourceRpc, revoker, { chainId: 11155111, source: await source.getAddress(), confirmations: 1 });
  let broadcasts = 0;
  const interrupted = await deliverRevocations(vault, { ...sender, broadcast: async transaction => {
    broadcasts++;
    assert.equal(new EvidenceVault(casePath, caseKey).getRevocation(caseId)!.transaction!.raw, transaction.raw);
    await sender.broadcast(transaction);
    throw new Error('synthetic lost broadcast acknowledgement after actual local acceptance');
  }, wait: async () => { throw new Error('synthetic process interruption before receipt recovery'); } }, () => rescreenNow + 1);
  assert.deepEqual(interrupted, { confirmed: 0, failed: 1, pending: 1 });
  const retained = new EvidenceVault(casePath, caseKey).getRevocation(caseId)!;
  assert.equal(retained.state, 'prepared'); assert.ok(retained.transaction!.raw.length > 2);
  const recoveredVault = new EvidenceVault(casePath, caseKey);
  const recovered = await deliverRevocations(recoveredVault, { ...sender,
    prepare: async () => assert.fail('restart must not sign a replacement transaction'),
    broadcast: async () => assert.fail('a mined original transaction must not be rebroadcast'),
  }, () => rescreenNow + 2);
  assert.deepEqual(recovered, { confirmed: 1, failed: 0, pending: 0 });
  const caseJob = recoveredVault.getRevocation(caseId)!;
  assert.equal(caseJob.state, 'confirmed'); assert.equal(caseJob.transaction!.raw, '');
  assert.equal(recoveredVault.get(bobEntry.requestId)!.state, 'blocked');
  assert.equal(broadcasts, 1); assert.equal(await sourceRpc.getTransactionCount(revoker.address), nonceBefore + 1);
  assert.deepEqual(await deliverRevocations(new EvidenceVault(casePath, caseKey), sender), { confirmed: 0, failed: 0, pending: 0 });
  assert.equal(await sourceRpc.getTransactionCount(revoker.address), nonceBefore + 1);
  const revoked = (await sourceRpc.getTransactionReceipt(caseJob.transaction!.hash))!;
  const revocationConfig = { source: await source.getAddress(), asc: await asc.getAddress(), registry: await registry.getAddress(),
    expectedRevoker: revoker.address, sourceCodeHash: ethers.keccak256(await sourceRpc.getCode(await source.getAddress())),
    ascCodeHash: ethers.keccak256(await hubRpc.getCode(await asc.getAddress())),
    registryCodeHash: ethers.keccak256(await hubRpc.getCode(await registry.getAddress())), policyIds: [1, 2], confirmations: 1 };
  const revocationObservedAt = Math.max((await sourceRpc.getBlock('latest'))!.timestamp, (await hubRpc.getBlock('latest'))!.timestamp);
  const waiting = await checkRevocation(sourceRpc, hubRpc, caseJob, revocationConfig, revocationObservedAt);
  assert.equal(waiting.state, 'AWAITING_HUB');
  recoveredVault.recordRevocationObservation(caseId, caseJob, revocationObservation(waiting, revocationConfig, 'synthetic-local-operator'), revocationObservedAt * 1000 + 500);
  assert.equal(await note.canTransfer(alice.address, bob.address), true, 'source revoke alone is not yet hub knowledge');
  await relay(revoked, 1); assert.equal(await registry.isVerified(bob.address, 2), false);
  await consumer(bob.address, false);
  const beforeEnforced = recoveredVault.getRevocation(caseId)!;
  const enforced = await checkRevocation(sourceRpc, hubRpc, beforeEnforced, revocationConfig, revocationObservedAt + 1);
  assert.equal(enforced.state, 'ENFORCED'); assert.equal(enforced.enforced, true);
  assert.equal(enforced.source!.transactionHash, revoked.hash);
  recoveredVault.recordRevocationObservation(caseId, beforeEnforced, revocationObservation(enforced, revocationConfig, 'synthetic-local-operator'), (revocationObservedAt + 1) * 1000 + 500);
  const recorded = new EvidenceVault(casePath, caseKey).getRevocation(caseId)!;
  assert.deepEqual(recorded.observations!.map(value => value.observation.state), ['AWAITING_HUB', 'ENFORCED']);
  assert.equal(recorded.state, 'confirmed'); assert.equal(recoveredVault.get(bobEntry.requestId)!.state, 'blocked');
  const localMonitor = monitorVault(recoveredVault.monitoringSnapshot(), monitorLimits, (revocationObservedAt + 1) * 1000 + 501);
  assert.equal(localMonitor.status, 'NO_LOCAL_FINDINGS'); assert.equal(localMonitor.currentEnforcement, 'NOT_CHECKED');
  assert.equal(monitorVault(recoveredVault.monitoringSnapshot(), monitorLimits, (revocationObservedAt + 2) * 1000).counts.HUB_OBSERVATION_STALE, 1);
  const caseBytes = readFileSync(casePath);
  // The test chains use a future fixed timestamp. Production CLI must reject that stale/future
  // wall-clock mismatch, not accept a caller-supplied observation clock override.
  const checkCli = spawnSync(process.execPath, ['--import', 'tsx', 'script/check-revocation.ts', caseId], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH,
      EVIDENCE_VAULT_PATH: casePath, EVIDENCE_VAULT_KEY: caseKey, SOURCE_CHAIN_RPC_URL: sourceRpc._getConnection().url,
      CREDITCOIN_RPC_URL: hubRpc._getConnection().url, SOURCE_CONTRACT_ADDRESS: revocationConfig.source,
      REVOCATION_ASC_ADDRESS: revocationConfig.asc, REVOCATION_REGISTRY_ADDRESS: revocationConfig.registry,
      REVOCATION_EXPECTED_REVOKER: revocationConfig.expectedRevoker, REVOCATION_SOURCE_CODE_HASH: revocationConfig.sourceCodeHash,
      REVOCATION_ASC_CODE_HASH: revocationConfig.ascCodeHash, REVOCATION_REGISTRY_CODE_HASH: revocationConfig.registryCodeHash,
      REVOCATION_POLICY_IDS: '1,2', RESCREEN_CONFIRMATIONS: '1' },
  });
  assert.equal(checkCli.status, 1); assert.equal(checkCli.stderr.trim(), 'STALE_OR_INVALID_HEAD');
  assert.deepEqual(readFileSync(casePath), caseBytes);
  await rejectedTransfer(bob.address, 'RecipientNotVerified');
  assert.deepEqual(await balances(), before);
  const second = await publish(2); assert.equal(second.snapshot.tree.entries.length, 1); assert.equal(second.snapshot.tree.entries[0].subject, alice.address);
  assert.equal(await registry.isVerified(alice.address, 2), false, 'new epoch invalidates old witness');
  await assert.rejects(checkBundleProof(hubRpc, consumerScope, replica.proof(alice.address), 2n), /not the current fresh on-chain epoch/);
  await assert.rejects(registry.cacheRosterWitness.staticCall(...a1.args), /InvalidRosterWitness/);
  // A successful earlier simulation is not permission to bypass current onchain state.
  const staleWitness = await alice.sendTransaction({ ...aChecked.transaction!, gasLimit: 300000 });
  await assert.rejects(staleWitness.wait(), (error: unknown) => {
    const e = error as { receipt?: ethers.TransactionReceipt }; return e.receipt?.status === 0 && e.receipt.hash === staleWitness.hash;
  });
  assert.equal(await registry.isVerified(alice.address, 2), false);
  const secondBundle = exportRosterBundle(second.record, consumerScope), currentReplica = loadRosterBundle(secondBundle.bytes, secondBundle.contentHash);
  const removed = await checkBundleProof(hubRpc, consumerScope, currentReplica.proof(bob.address), 2n);
  assert.equal(removed.proofAccepted, true); assert.equal(removed.eligible, false); assert.equal(removed.transaction, undefined);
  const currentWitness = await checkBundleProof(hubRpc, consumerScope, currentReplica.proof(alice.address), 2n);
  assert.equal(currentWitness.eligible, true);
  assert.equal((await (await alice.sendTransaction(currentWitness.transaction!)).wait())!.status, 1);
  assert.equal(await registry.isVerified(alice.address, 2), true);
  await hubRpc.send('evm_setNextBlockTimestamp', [second.validUntil]); await hubRpc.send('evm_mine', []);
  assert.equal(await asc.isRosterFresh(), false); assert.equal(await registry.isVerified(alice.address, 2), false);
  await assert.rejects(checkBundleProof(hubRpc, consumerScope, currentReplica.proof(alice.address), 2n), /not the current fresh on-chain epoch/);
  await consumer(alice.address, false);
  assert.ok(entries[0].outcome.status === 'ISSUED' && entries[0].outcome.expiry > second.validUntil);
  await assert.rejects(registry.cacheRosterWitness.staticCall(...encodeRosterWitness(second.record, alice.address).args));
  assert.equal(await note.canTransfer(alice.address, alice.address), false);
  await rejectedTransfer(alice.address, 'SenderNotVerified');
  assert.deepEqual(await balances(), before);
});
