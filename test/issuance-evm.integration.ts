import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { EvmIssuanceTransport, RotatingIssuerEvmTransport, ISSUANCE_ASC_ABI, issuanceProvider,
  validateRotatingSignedIssuance, validateSignedIssuance } from '../pipeline/issuance-evm.js';
import { packAttrs, unpackAttrs } from '../pipeline/attrs.js';
import type { IssuanceEntry, SourceConfirmation } from '../pipeline/issuance-journal.js';
import { rosterApprovalData, readRootApprovals } from '../pipeline/roster-authorization.js';
import { issuerApprovalData, encodeIssuerSignature, encodeIssuerIssue } from '../pipeline/issuer-key.js';
import { buildSourceRoster } from '../pipeline/roster-source.js';

// The source is a real local EVM. Hub responses below are explicit synthetic materialization
// fixtures, not an Attestcoin proof; the Solidity suites cover ASC proof/event processing.
class Hub extends ethers.AbstractProvider {
  active = false; tombstoned = false; confirmation?: SourceConfirmation; source = ethers.ZeroAddress;
  issuerKeyEpoch = 0n; issuerUsable = true;
  entry!: IssuanceEntry;
  readonly abi = new ethers.Interface(ISSUANCE_ASC_ABI);
  constructor() { super(102031, { cacheTimeout: -1 }); }
  async _detectNetwork() { return ethers.Network.from(102031); }
  async _perform(req: ethers.PerformActionRequest): Promise<unknown> {
    if (req.method === 'getBlockNumber') return 100;
    if (req.method !== 'call') throw new Error(`unsupported synthetic hub method ${req.method}`);
    const name = this.abi.getFunction(req.transaction.data!.slice(0, 10))!.name;
    const out = this.entry.outcome;
    if (out.status !== 'ISSUED') throw new Error('bad fixture');
    const attrs = unpackAttrs(out.attrs);
    const value: Record<string, unknown[]> = {
      expectedChainKey: [1], sourceContract: [this.source], tombstone: [this.tombstoned],
      markIssuerKeyEpoch: [this.issuerKeyEpoch], isMarkIssuerUsable: [this.issuerUsable],
      lastAppliedHeight: [this.confirmation?.blockNumber ?? 0], lastAppliedTxIndex: [this.confirmation?.transactionIndex ?? 0],
      getMark: [[this.active ? 1 : 0, 1, attrs.kind, attrs.assurance, attrs.regime, attrs.jurisdiction, attrs.methods,
        attrs.issuedAt, attrs.expiry, attrs.epoch, out.claimsRoot, out.evidenceHash, this.entry.target.issuer]],
    };
    return this.abi.encodeFunctionResult(name, value[name]);
  }
}

test('real source receipt, exact payload, canonical block, reorg and reverted retry', async t => {
  const portProbe = createServer(); await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '11155111', '--silent'], { stdio: 'ignore' });
  t.after(async () => { if (anvil.exitCode === null) { anvil.kill('SIGTERM'); await new Promise(resolve => anvil.once('exit', resolve)); } });
  const sourceUrl = `http://127.0.0.1:${port}`;
  const provider = issuanceProvider(sourceUrl), headerProvider = issuanceProvider(sourceUrl);
  t.after(() => { provider.destroy(); headerProvider.destroy(); });
  for (let attempt = 0; ; attempt++) {
    try { await provider.getBlockNumber(); break; } catch { if (attempt >= 30) throw new Error('isolated Anvil did not become ready'); await delay(100); }
  }
  const mnemonic = 'test test test test test test test test test test test junk';
  const owner = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/0").privateKey, provider);
  const signer = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1").privateKey, provider);
  const artifact = JSON.parse(readFileSync(new URL('../out/ComplianceSource.sol/ComplianceSource.json', import.meta.url), 'utf8'));
  const deployed = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, owner).deploy(owner.address);
  await deployed.waitForDeployment();
  const source = new ethers.Contract(await deployed.getAddress(), artifact.abi, owner);
  await (await source.setIssuer(signer.address, true)).wait();
  const hub = new Hub(); t.after(() => hub.destroy()); hub.source = await source.getAddress();
  const entry: IssuanceEntry = { version: 1, requestId: ethers.id('synthetic-issue'), wallet: ethers.Wallet.createRandom().address,
    fingerprint: ethers.id('synthetic-input'), consentVersion: 'test', createdAt: Date.now(), prepareUntil: Date.now() + 900000,
    phase: 'prepared', target: { chainId: 11155111, source: hub.source, issuer: signer.address, hubChainId: 102031, asc: '0x' + '22'.repeat(20) },
    outcome: { status: 'ISSUED', attrs: packAttrs({ kind: 1, assurance: 3, regime: 2, jurisdiction: 410, methods: 63, issuedAt: 1700000000, expiry: 1800000000, epoch: 0 }),
      claimsRoot: ethers.id('synthetic-claims'), evidenceHash: ethers.id('synthetic-evidence'), methods: 63, methodNames: [], expiry: 1800000000, regime: 2, claims: [], evidence: [] },
    assurance: 3, evidenceStored: true, revertedTransactions: [] };
  hub.entry = structuredClone(entry);
  const transport = new EvmIssuanceTransport(provider, hub, signer, 1, entry.target);
  await transport.assertTarget(entry);
  const snapshot = await provider.send('evm_snapshot', []);
  entry.transaction = await transport.prepare(entry);
  validateSignedIssuance(entry, entry.transaction);
  for (const altered of [ { ...entry, requestId: ethers.id('another-request') }, { ...entry, wallet: owner.address },
    { ...entry, target: { ...entry.target, chainId: 1 } }, { ...entry, target: { ...entry.target, issuer: owner.address } } ]) {
    assert.throws(() => validateSignedIssuance(altered, entry.transaction!), /does not match/);
  }
  assert.equal((await transport.receipt(entry)).status, 'pending');
  await transport.broadcast(entry.transaction);
  const receipt = await transport.receipt(entry); assert.equal(receipt.status, 'success');
  if (receipt.status !== 'success') throw new Error('source not confirmed');
  const checkDemoReceipt = async (hash: string, to: string, expectedIssuer: string, expectedSubject: string) => {
    if (entry.outcome.status !== 'ISSUED') throw new Error('expected issued fixture');
    const raw = spawnSync('cast', ['receipt', hash, '--json', '--rpc-url', `http://127.0.0.1:${port}`],
      { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 5000 });
    assert.equal(raw.status, 0, raw.stderr);
    const head = await provider.getBlockNumber();
    const args = [hash, hub.source, to, expectedIssuer, expectedSubject, entry.outcome.attrs,
      entry.outcome.claimsRoot, entry.outcome.evidenceHash, String(head), '1'];
    const check = (values: string[]) => spawnSync(process.execPath, ['script/demo-issuance.mjs', ...values],
      { input: raw.stdout, encoding: 'utf8', timeout: 5000 });
    const result = check(args); assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(raw.stdout);
    assert.equal(result.stdout.trim(), `${Number(parsed.blockNumber)} ${parsed.blockHash.toLowerCase()} ${Number(parsed.transactionIndex)} 0`);
    const wrongIssuer = [...args]; wrongIssuer[3] = owner.address; assert.notEqual(check(wrongIssuer).status, 0);
    const wrongTarget = [...args]; wrongTarget[2] = owner.address; assert.notEqual(check(wrongTarget).status, 0);
  };
  await checkDemoReceipt(entry.transaction.hash, hub.source, signer.address, entry.wallet);
  assert.equal(await transport.processed(entry), true);
  assert.equal(await transport.materialized(entry, receipt.confirmation), false);
  hub.active = true; hub.confirmation = receipt.confirmation;
  assert.equal(await transport.materialized(entry, receipt.confirmation), true);
  hub.tombstoned = true; assert.equal(await transport.materialized(entry, receipt.confirmation), false); hub.tombstoned = false;
  hub.confirmation = { ...receipt.confirmation, transactionIndex: receipt.confirmation.transactionIndex + 1 };
  assert.equal(await transport.materialized(entry, receipt.confirmation), false);
  // Removing the source block must not leave a source-confirmed result in the transport.
  assert.equal(await provider.send('evm_revert', [snapshot]), true);
  assert.equal((await transport.receipt(entry)).status, 'pending');
  assert.equal(await transport.processed(entry), false);
  await (await source.setIssuer(signer.address, false)).wait();
  await transport.broadcast(entry.transaction);
  assert.equal((await transport.receipt(entry)).status, 'reverted');
  await (await source.setIssuer(signer.address, true)).wait();
  const retry = await transport.prepare(entry);
  assert.equal(retry.nonce, entry.transaction.nonce + 1);
  entry.transaction = retry; await transport.broadcast(retry);
  assert.equal((await transport.receipt(entry)).status, 'success');
  // Cross-language approval test on this isolated source EVM. No external keys or RPCs.
  await (await source.setEpochPublisher(owner.address, true)).wait();
  const cutoff = (await provider.getBlock('latest'))!.timestamp;
  const typed = rosterApprovalData(11155111n, await source.getAddress(), { epoch: 1, root: ethers.id('synthetic-roster'),
    listVersion: 9, validUntil: cutoff + 86400, sourceCutoff: cutoff, snapshotId: ethers.id('synthetic-snapshot'), publisher: owner.address });
  const m = typed.value;
  const args = [m.epoch, m.root, m.listVersion, m.validUntil, m.sourceCutoff, m.snapshotId] as const;
  assert.equal(await source.rosterApprovalDigest(...args, owner.address), typed.digest);
  const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
  const approvals = readRootApprovals({ version: 1, digest: typed.digest, approvals: [{ issuer: signer.address, signature }] }, typed.digest, [signer.address]);
  await source.publishEpochForIssuers.staticCall(...args, approvals);
  const epochReceipt = await (await source.publishEpochForIssuers(...args, approvals)).wait();
  const events = epochReceipt.logs.map((log: ethers.Log) => source.interface.parseLog(log));
  assert.deepEqual(events.map((event: ethers.LogDescription) => event.name), ['RosterIssuerAuthorized', 'RosterEpochPublished']);
  assert.equal(events[0].args.issuer, signer.address);
  assert.equal(await source.lastEpoch(), 1n);
  await assert.rejects(source.publishEpochForIssuers.staticCall(...args, approvals));

  // T-12: same real local source, new stable issuer with keys that have NO direct source role.
  const operating = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/2").privateKey, provider);
  const replacement = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/3").privateKey, provider);
  const issuerArtifact = JSON.parse(readFileSync(new URL('../out/RotatingIssuer.sol/RotatingIssuer.json', import.meta.url), 'utf8'));
  const issuerDeployment = await new ethers.ContractFactory(issuerArtifact.abi, issuerArtifact.bytecode.object, owner)
    .deploy(owner.address, operating.address, await source.getAddress());
  await issuerDeployment.waitForDeployment();
  const stable = new ethers.Contract(await issuerDeployment.getAddress(), issuerArtifact.abi, owner);
  const stableAddress = await stable.getAddress();
  await (await source.setIssuer(stableAddress, true)).wait();
  assert.equal(await source.isIssuer(operating.address), false);
  assert.equal(await source.isIssuer(replacement.address), false);
  const proposal = rosterApprovalData(11155111n, await source.getAddress(), { ...m, epoch: 2 });
  const wrapped = issuerApprovalData(11155111n, stableAddress, proposal.digest, 1n);
  assert.equal(await stable.approvalDigest(proposal.digest, 1), wrapped.digest);
  const oldSignature = encodeIssuerSignature(1n, await operating.signTypedData(wrapped.domain, wrapped.types, wrapped.value));
  assert.equal(await stable.isValidSignature(proposal.digest, oldSignature), '0x1626ba7e');
  await (await stable.proposeKey(replacement.address)).wait();
  await (await new ethers.Contract(stableAddress, issuerArtifact.abi, replacement).acceptKey(1)).wait();
  assert.equal(await stable.keyEpoch(), 2n);
  assert.equal(await stable.isValidSignature(proposal.digest, oldSignature), '0xffffffff');
  const p = proposal.value;
  const nextArgs = [p.epoch, p.root, p.listVersion, p.validUntil, p.sourceCutoff, p.snapshotId] as const;
  await assert.rejects(source.publishEpochForIssuers.staticCall(...nextArgs, [{ issuer: stableAddress, signature: oldSignature }]));
  const renewed = issuerApprovalData(11155111n, stableAddress, proposal.digest, 2n);
  const currentSignature = encodeIssuerSignature(2n, await replacement.signTypedData(renewed.domain, renewed.types, renewed.value));
  await (await source.publishEpochForIssuers(...nextArgs, [{ issuer: stableAddress, signature: currentSignature }])).wait();
  const stableRequest = ethers.id('synthetic stable issuer request');
  const stableEntry = structuredClone(entry);
  stableEntry.requestId = stableRequest; stableEntry.wallet = owner.address; stableEntry.transaction = undefined;
  stableEntry.target = { ...entry.target, issuer: stableAddress, issuerMode: 'rotating',
    operatingKey: replacement.address, issuerKeyEpoch: 2 };
  hub.entry = stableEntry; hub.issuerKeyEpoch = 2n;
  const stableTransport = new RotatingIssuerEvmTransport(provider, hub, replacement, 1, stableEntry.target);
  await stableTransport.assertTarget(stableEntry);
  stableEntry.transaction = await stableTransport.prepare(stableEntry);
  validateRotatingSignedIssuance(stableEntry, stableEntry.transaction);
  for (const altered of [
    { ...stableEntry, target: { ...stableEntry.target, issuerKeyEpoch: 3 } },
    { ...stableEntry, target: { ...stableEntry.target, operatingKey: operating.address } },
    { ...stableEntry, target: { ...stableEntry.target, issuer: owner.address } },
  ]) assert.throws(() => validateRotatingSignedIssuance(altered, stableEntry.transaction!), /does not match/);
  const calldata = encodeIssuerIssue(2n, stableRequest, owner.address, entry.outcome.attrs, entry.outcome.claimsRoot, entry.outcome.evidenceHash);
  await assert.rejects(provider.call({ from: operating.address, to: stableAddress, data: calldata }));
  await stableTransport.broadcast(stableEntry.transaction);
  const stableResult = await stableTransport.receipt(stableEntry);
  assert.equal(stableResult.status, 'success');
  if (stableResult.status !== 'success') throw new Error('stable source not confirmed');
  const stableReceipt = await provider.getTransactionReceipt(stableEntry.transaction.hash);
  const issued = stableReceipt!.logs.filter(log => log.address.toLowerCase() === hub.source.toLowerCase())
    .map(log => source.interface.parseLog(log)).find(log => log?.name === 'MarkIssued');
  const keyedIssued = stableReceipt!.logs.filter(log => log.address.toLowerCase() === hub.source.toLowerCase())
    .map(log => source.interface.parseLog(log)).find(log => log?.name === 'KeyedMarkIssued');
  assert.equal(issued, undefined); assert.equal(keyedIssued?.args.issuer, stableAddress); assert.equal(keyedIssued?.args.issuerKeyEpoch, 2n);
  // Outer destination is the stable issuer; the trusted event still comes from ComplianceSource.
  await checkDemoReceipt(stableReceipt!.hash, stableAddress, stableAddress, owner.address);
  assert.equal(await source.processedRequest(stableRequest), true);
  await assert.rejects(provider.call({ from: replacement.address, to: stableAddress, data: calldata }));
  hub.active = true; hub.confirmation = stableResult.confirmation;
  assert.equal(await stableTransport.materialized(stableEntry, stableResult.confirmation), true);
  hub.issuerUsable = false;
  assert.equal(await stableTransport.materialized(stableEntry, stableResult.confirmation), false);
  hub.issuerUsable = true;
  await (await stable.suspend(ethers.id('synthetic incident'))).wait();
  assert.equal(await stable.isValidSignature(proposal.digest, currentSignature), '0xffffffff');

  // T-18: full source receipts replay, including an actual revoke deliberately never sent to Hub.
  const snapshotOptions = { source: await source.getAddress(), chainId: 11155111n,
    deploymentTx: deployed.deploymentTransaction()!.hash, confirmations: 1, logChunk: 3, headerReader: headerProvider };
  // Anvil's finalized tag lags its head. Advance real local blocks, never relabel latest as finalized.
  await provider.send('anvil_mine', ['0x41']);
  const beforeRevoke = await buildSourceRoster(provider, snapshotOptions);
  assert.equal(beforeRevoke.tree.entries.length, 2);
  await (await new ethers.Contract(await source.getAddress(), artifact.abi, signer).revoke(entry.wallet, 1, 2)).wait();
  await provider.send('anvil_mine', ['0x41']);
  const afterRevoke = await buildSourceRoster(provider, snapshotOptions);
  assert.equal(afterRevoke.tree.entries.length, 1);
  assert.equal(afterRevoke.tree.entries[0].subject, owner.address);
  assert.match(afterRevoke.excluded.find(e => e.subject === entry.wallet)!.reason, /revoke/);
  const originalCutoff = await buildSourceRoster(provider, { ...snapshotOptions,
    cutoffBlock: beforeRevoke.manifest.cutoffBlock, expectedCutoffHash: beforeRevoke.manifest.cutoffBlockHash });
  assert.deepEqual(originalCutoff, beforeRevoke);
});
