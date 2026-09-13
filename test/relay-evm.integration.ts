import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ethers } from 'ethers';
import { Store } from '../worker/store.js';
import { EvmRelayTransport, RelaySender } from '../worker/relay.js';
import { issuanceProvider } from '../pipeline/issuance-evm.js';

test('real relay nonce, confirmation, restart, revert, reorg and unknown replacement stay reconciled', async t => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '102031', '--silent'], { stdio: 'ignore' });
  t.after(async () => { if (anvil.exitCode === null) { anvil.kill('SIGTERM'); await new Promise(resolve => anvil.once('exit', resolve)); } });
  const provider = issuanceProvider(`http://127.0.0.1:${port}`); t.after(() => provider.destroy());
  for (let n = 0; ; n++) {
    try { await provider.getBlockNumber(); break; } catch { if (n >= 30) throw new Error('isolated Anvil not ready'); await delay(100); }
  }
  const mnemonic = 'test test test test test test test test test test test junk';
  const owner = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic).privateKey, provider);
  const wallet = new ethers.Wallet(ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, "m/44'/60'/0'/0/1").privateKey, provider);
  const artifact = JSON.parse(readFileSync(new URL('../out/RelayReceiptFixture.sol/RelayReceiptFixture.json', import.meta.url), 'utf8'));
  const target = await new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, owner).deploy(); await target.waitForDeployment();
  const contract = new ethers.Contract(await target.getAddress(), artifact.abi, provider);
  const dir = mkdtempSync(join(tmpdir(), 'proofmark-relay-evm-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json'); let store = new Store(path);
  for (const id of ['a', 'b', 'c', 'd', 'x']) store.add({ txHash: id, blockNumber: 1, action: 0, eventName: 'synthetic', logCount: 1, state: 'attested', attempts: 0 });
  const transport = new EvmRelayTransport(provider, wallet, contract, 2);
  // A third party's latest-block execution cannot permanently skip our unsigned job.
  const skipStore = new Store(join(dir, 'third-party.json'));
  skipStore.add({ txHash: 'external', blockNumber: 1, action: 0, eventName: 'synthetic', logCount: 1, state: 'attested', attempts: 0 });
  const externalQuery = ethers.id('external'), externalArgs = { queryId: externalQuery,
    data: contract.interface.encodeFunctionData('execute', [externalQuery, false]), gasLimit: 150000n };
  const beforeExternal = await provider.send('evm_snapshot', []);
  await (await contract.connect(owner).getFunction('execute')(externalQuery, false)).wait();
  const skipSender = new RelaySender(skipStore, transport);
  await skipSender.step('external', externalArgs);
  assert.equal(skipStore.get('external')?.state, 'attested'); assert.equal(skipStore.relay, undefined);
  assert.equal(await provider.getTransactionCount(wallet.address), 0);
  await provider.send('evm_mine', []);
  const changedSkip = new RelaySender(skipStore, transport, async () => {
    assert.equal(await provider.send('evm_revert', [beforeExternal]), true);
    await provider.send('evm_mine', []); await provider.send('evm_mine', []);
  });
  await assert.rejects(changedSkip.step('external', externalArgs), /ASC_QUERY_OBSERVATION_CHANGED/);
  assert.equal(skipStore.get('external')?.state, 'attested'); assert.equal(skipStore.get('external')?.skipObservation, undefined);
  await (await contract.connect(owner).getFunction('execute')(externalQuery, false)).wait(); await provider.send('evm_mine', []);
  await skipSender.step('external', externalArgs);
  assert.equal(skipStore.get('external')?.state, 'skipped');
  const skip = new Store(join(dir, 'third-party.json')).get('external')!.skipObservation!;
  assert.ok(skip.confirmations >= 2); assert.equal((await provider.getBlock(skip.blockNumber))?.hash, skip.blockHash);
  assert.equal(await provider.getTransactionCount(wallet.address), 0);
  let sender = new RelaySender(store, transport);
  const preparation = (id: string, fail = false) => ({ queryId: ethers.id(id), data: contract.interface.encodeFunctionData('execute', [ethers.id(id), fail]), gasLimit: 150000n });
  await sender.step('a', preparation('a')); const original = store.relay!;
  assert.equal(store.get('a')?.state, 'submitted', 'one block is below confirmation depth');
  await assert.rejects(sender.step('b', preparation('b')), /NONCE_UNRESOLVED/);
  store = new Store(path); sender = new RelaySender(store, transport);
  await provider.send('evm_mine', []); await sender.step('a');
  assert.equal(store.get('a')?.state, 'done'); assert.equal(store.get('a')?.ascTxHash, original.hash);
  await sender.step('b', preparation('b', true)); const failed = store.relay!;
  assert.equal(failed.nonce, original.nonce + 1);
  await provider.send('evm_mine', []); await sender.step('b');
  assert.equal(store.get('b')?.state, 'dead'); assert.equal(store.relay, undefined);

  // A confirmed revert disappears while the sender awaits the source guard. Reverts have
  // no processedQueries=true check to accidentally mask a missing final receipt validation.
  const beforeX = await provider.send('evm_snapshot', []);
  await sender.step('x', preparation('x', true)); const x = store.relay!;
  const oldReceipt = await provider.getTransactionReceipt(x.hash); assert.equal(oldReceipt?.status, 0);
  await provider.send('evm_mine', []);
  let forked = false;
  const racing = new RelaySender(store, transport, async () => {
    if (!forked) {
      forked = true; assert.equal(await provider.send('evm_revert', [beforeX]), true);
      await provider.send('evm_mine', []); await provider.send('evm_mine', []);
    }
  });
  await racing.step('x');
  assert.equal(store.get('x')?.state, 'submitted'); assert.equal(store.relay?.hash, x.hash);
  assert.equal(store.get('x')?.relayHistory, undefined);
  await assert.rejects(sender.step('c', preparation('c')), /NONCE_UNRESOLVED/);
  store = new Store(path); sender = new RelaySender(store, transport);
  await sender.step('x'); await provider.send('evm_mine', []); await sender.step('x');
  assert.equal(store.get('x')?.state, 'dead'); assert.equal(store.relay, undefined);
  assert.equal(store.get('x')?.relayHistory?.[0].hash, x.hash);
  assert.notEqual(store.get('x')?.relayHistory?.[0].blockHash, oldReceipt?.blockHash);

  // Remove C's source-independent hub receipt before confirmation, then use its nonce for an
  // unrelated replacement. The worker must not mistake nonce consumption for C's success.
  const snapshot = await provider.send('evm_snapshot', []);
  await sender.step('c', preparation('c')); const pending = store.relay!;
  assert.equal(await provider.send('evm_revert', [snapshot]), true);
  assert.equal((await transport.receipt(pending)).status, 'pending');
  await (await wallet.sendTransaction({ to: owner.address, value: 1n, nonce: pending.nonce })).wait();
  await provider.send('evm_mine', []);
  await sender.step('c');
  assert.equal(store.get('c')?.state, 'submitted'); assert.equal(store.relay?.hash, pending.hash);
  assert.equal(await contract.processedQueries(ethers.id('c')), false);
  await assert.rejects(sender.step('d', preparation('d')), /NONCE_UNRESOLVED/);
});
